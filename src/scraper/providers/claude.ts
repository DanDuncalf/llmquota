// =============================================================================
// Anthropic / Claude scraper  (Claude Pro / Max plan windows)
// =============================================================================
// Claude exposes the same usage payload two ways:
//
//   1. OAuth (Claude Code token)
//        GET https://api.anthropic.com/api/oauth/usage
//        Authorization: Bearer <oauth token>
//        anthropic-beta: oauth-2025-04-20
//      Token sources, in order:
//        - CLAUDE_CODE_OAUTH_TOKEN env
//        - ~/.claude/.credentials.json  →  claudeAiOauth.accessToken
//
//   2. Web session (whatever you're logged into claude.ai with)
//        GET https://claude.ai/api/organizations/{org_uuid}/usage
//        Cookie: sessionKey=<value>
//      Needs CLAUDE_SESSION_KEY. The org UUID is auto-read from
//      ~/.claude.json (oauthAccount.organizationUuid) unless CLAUDE_ORG_UUID
//      is set explicitly.
//
// Both return { five_hour, seven_day, seven_day_sonnet, seven_day_opus,
// extra_usage }, where each window is { utilization (0-100), resets_at } or
// null when the plan doesn't expose it.
//
// If neither credential is present we emit an `unavailable` bucket so the card
// still renders (greyed) instead of silently vanishing.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket } from './base.js';

const execFileAsync = promisify(execFile);

interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
}

const CLAUDE_CREDENTIALS = () =>
  process.env.CLAUDE_CREDENTIALS_PATH ?? path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_CONFIG = () =>
  process.env.CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), '.claude.json');

// -----------------------------------------------------------------------------
// Last-known-usage cache + rate limiting
// -----------------------------------------------------------------------------
// api.anthropic.com/api/oauth/usage rate-limits aggressively. A full scrape can
// run far more often than that (the daemon every 60s, and each `llmquota
// --refresh` spawns a one-shot scrape), so a transient 429 must not blank the
// card. Keep the last good payload on disk and back off after a rate limit.
const CACHE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/claude-usage-cache.json',
);

interface ClaudeUsageCache {
  fetched_at: string;
  source: string;
  usage: ClaudeUsageResponse | null;
  /** When set and in the future, do not call the usage endpoint. */
  retry_at?: string;
  /** Human-readable reason for the last failure (shown on the card). */
  last_error?: string;
}

const MIN_FETCH_INTERVAL_MS = Math.max(
  0,
  Number(process.env.CLAUDE_MIN_FETCH_INTERVAL_MS ?? 5 * 60_000),
);
const RATE_LIMIT_BACKOFF_MS = Math.max(
  0,
  Number(process.env.CLAUDE_RATE_LIMIT_BACKOFF_MS ?? 10 * 60_000),
);
const CACHE_MAX_AGE_MS = Math.max(
  0,
  Number(process.env.CLAUDE_CACHE_MAX_AGE_MS ?? 6 * 3_600_000),
);

function readCache(): ClaudeUsageCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as ClaudeUsageCache;
    return parsed?.fetched_at ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: ClaudeUsageCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    // Unique temp name: concurrent one-shot scrapes may write at the same time.
    const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.warn('[claude] failed to write usage cache:', err);
  }
}

function cacheAgeMs(cache: ClaudeUsageCache): number {
  const t = Date.parse(cache.fetched_at);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

/** The scraper only renders these two windows; a cache without them is useless. */
function hasWindows(usage: ClaudeUsageResponse | null | undefined): boolean {
  return !!(usage?.five_hour?.resets_at || usage?.seven_day?.resets_at);
}

/** Compact timestamp for the row label, e.g. "Nov 10, 10:14 AM". */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// -----------------------------------------------------------------------------
// OAuth token management (self-refreshing)
// -----------------------------------------------------------------------------
// Claude Code access tokens live only a few hours and are normally refreshed by
// the `claude` CLI when *it* runs. This dashboard may run for days without the
// CLI being launched, so it refreshes the token itself using the refresh token
// in ~/.claude/.credentials.json, and writes the rotated pair back so the CLI
// stays logged in. Refresh tokens ROTATE: every refresh invalidates the old one,
// so the write-back is atomic and the whole refresh is guarded by a lock file
// (the daemon and one-shot `--refresh` scrapes can run concurrently).
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Public client id of the Claude Code app — no client secret is involved.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_LOCK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/claude-refresh.lock',
);
const LOGIN_HINT = 'Claude login expired — run `claude`, then /login, once';

/** Thrown when the stored login can no longer be refreshed automatically. */
export class ClaudeAuthError extends Error {}

interface StoredOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  [k: string]: unknown;
}

function readCredsFile(): { raw: Record<string, unknown>; oauth: StoredOauth } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS(), 'utf8')) as Record<string, unknown>;
    const oauth = raw.claudeAiOauth as StoredOauth | undefined;
    return oauth ? { raw, oauth } : null;
  } catch {
    return null;
  }
}

function writeCredsFile(raw: Record<string, unknown>): void {
  const file = CLAUDE_CREDENTIALS();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function tokenIsFresh(o: StoredOauth | undefined): boolean {
  return !!(o?.accessToken && (!o.expiresAt || o.expiresAt - REFRESH_SKEW_MS > Date.now()));
}

/** POST a form body to the OAuth endpoint with curl (body via stdin, so the
 *  refresh token never shows up in a process listing). curl is used because
 *  Cloudflare 403s Node's fetch TLS fingerprint on these hosts. */
function curlPostForm(url: string, form: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'curl',
      ['-sS', '-m', '20', '-w', '\n%{http_code}', '-X', 'POST', url,
       '-H', 'Content-Type: application/x-www-form-urlencoded',
       '-H', 'User-Agent: quota-dashboard/1.0 (personal local usage tracker)',
       '--data-binary', '@-'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${err.trim().slice(0, 200)}`));
      const lines = out.split('\n');
      const status = Number(lines.pop()?.trim() ?? '0');
      resolve({ status, body: lines.join('\n').trim() });
    });
    child.stdin.end(form);
  });
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(REFRESH_LOCK_PATH), { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(REFRESH_LOCK_PATH, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A crashed holder must not wedge us forever.
      try {
        if (Date.now() - fs.statSync(REFRESH_LOCK_PATH).mtimeMs > 30_000) fs.rmSync(REFRESH_LOCK_PATH, { force: true });
      } catch { /* raced with the holder releasing it */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for Claude token refresh lock');
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmSync(REFRESH_LOCK_PATH, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Return a usable OAuth access token, refreshing (and persisting) it when it is
 * expired or about to be. `force` refreshes even if the stored token looks
 * valid — used after the API rejects it with 401/403.
 * Returns null when there is no OAuth login at all; throws ClaudeAuthError when
 * a login exists but cannot be refreshed.
 */
export async function getOauthToken(force = false): Promise<string | null> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const first = readCredsFile();
  if (!first?.oauth.accessToken && !first?.oauth.refreshToken) return null;
  if (!force && tokenIsFresh(first.oauth)) return first.oauth.accessToken!;
  if (!first.oauth.refreshToken) throw new ClaudeAuthError(`${LOGIN_HINT} (no refresh token stored)`);
  const staleAccess = first.oauth.accessToken;

  return withRefreshLock(async () => {
    // Someone else may have refreshed while we waited for the lock.
    const cur = readCredsFile();
    if (!cur?.oauth.refreshToken) throw new ClaudeAuthError(`${LOGIN_HINT} (no refresh token stored)`);
    if (tokenIsFresh(cur.oauth) && (!force || cur.oauth.accessToken !== staleAccess)) {
      return cur.oauth.accessToken!;
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cur.oauth.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();
    const { status, body } = await curlPostForm(OAUTH_TOKEN_URL, form);

    if (status < 200 || status >= 300) {
      console.warn(`[claude] token refresh failed: HTTP ${status}: ${body.slice(0, 200)}`);
      if (status === 400 || status === 401) {
        // invalid_grant: refresh token revoked/rotated elsewhere — needs a real login.
        throw new ClaudeAuthError(`${LOGIN_HINT} (refresh rejected, HTTP ${status})`);
      }
      throw new Error(`Claude token refresh failed: HTTP ${status}`);
    }

    const tok = JSON.parse(body) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!tok.access_token) throw new Error('Claude token refresh returned no access_token');

    const next: StoredOauth = {
      ...cur.oauth,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? cur.oauth.refreshToken,
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    };
    if (tok.scope) next.scopes = tok.scope.split(' ').filter(Boolean);
    // Persist BEFORE using it: the old refresh token is already dead.
    writeCredsFile({ ...cur.raw, claudeAiOauth: next });
    console.log('[claude] OAuth token refreshed; expires', new Date(next.expiresAt!).toISOString());
    return next.accessToken!;
  });
}

/** Read the Claude org UUID (needed for the claude.ai web endpoint). */
function readOrgUuid(): string | null {
  if (process.env.CLAUDE_ORG_UUID) return process.env.CLAUDE_ORG_UUID;
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_CONFIG(), 'utf8')) as {
      oauthAccount?: { organizationUuid?: string };
    };
    return parsed.oauthAccount?.organizationUuid ?? null;
  } catch {
    return null;
  }
}

async function fetchOauthUsage(token: string): Promise<ClaudeUsageResponse> {
  return httpJson<ClaudeUsageResponse>('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
}

async function fetchWebUsage(sessionKey: string, orgUuid: string): Promise<ClaudeUsageResponse> {
  const url = `https://claude.ai/api/organizations/${orgUuid}/usage`;
  // claude.ai sits behind Cloudflare, whose bot protection 403s Node's
  // `fetch` (undici TLS fingerprint). Plain curl passes, so shell out to it
  // for the claude.ai web endpoint.
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sS',
      '-m', '15',
      '-w', '\n%{http_code}',
      url,
      '-H', `Cookie: sessionKey=${sessionKey}`,
      '-H', 'Content-Type: application/json',
      '-H', 'User-Agent: quota-dashboard/1.0 (personal local usage tracker)',
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  const lines = stdout.split('\n');
  const status = Number(lines.pop()?.trim() ?? '0');
  const body = lines.join('\n').trim();
  if (status < 200 || status >= 300) {
    const err = new Error(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`) as Error & {
      status?: number;
    };
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as ClaudeUsageResponse;
}

function resetSeconds(w: UsageWindow): number {
  if (!w.resets_at) return 0;
  const ts = Date.parse(w.resets_at);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.round((ts - Date.now()) / 1000));
}

function windowBucket(
  modelId: string,
  windowLabel: string,
  displayName: string,
  tier: 'rolling_window' | 'periodic_fixed',
  hours: number,
  w: UsageWindow,
  note: string,
  lastUpdated: string = new Date().toISOString(),
): RawBucket {
  return {
    model_id: modelId,
    provider: 'anthropic',
    display_name: displayName,
    window_label: windowLabel,
    tier_type: tier,
    capacity: {
      used_pct: Math.round(Math.max(0, Math.min(100, w.utilization)) * 10) / 10,
      reset_in_seconds: resetSeconds(w),
      limit_window_hours: hours,
      resets_at: w.resets_at ?? undefined,
      limit_label: note,
    },
    last_updated: lastUpdated,
    notes: note,
  };
}

function buildBuckets(
  usage: ClaudeUsageResponse,
  source: string,
  lastUpdated: string,
  note: string = source,
): RawBucket[] {
  const buckets: RawBucket[] = [];

  // Anthropic reports a window with `resets_at: null` when there is no active
  // window (e.g. the weekly cap is exhausted). Rendering that as a 0% window
  // makes the calculator call it CRITICAL and mark it ★ NEXT, so skip it.
  if (usage.five_hour?.resets_at) {
    buckets.push(
      windowBucket(
        'claude-5h',
        '5h session',
        'Claude · 5-hour session',
        'rolling_window',
        5,
        usage.five_hour,
        note,
        lastUpdated,
      ),
    );
  }
  if (usage.seven_day?.resets_at) {
    buckets.push(
      windowBucket(
        'claude-weekly',
        'Weekly',
        'Claude · Weekly (all models)',
        'periodic_fixed',
        168,
        usage.seven_day,
        note,
        lastUpdated,
      ),
    );
  }

  return buckets;
}

export async function scrapeClaude(): Promise<RawBucket[]> {
  const cache = readCache();
  const now = Date.now();
  const cacheIsFresh = !!(
    cache?.usage &&
    hasWindows(cache.usage) &&
    cacheAgeMs(cache) <= CACHE_MAX_AGE_MS
  );
  const retryAt = cache?.retry_at ? Date.parse(cache.retry_at) : NaN;

  // 1. Still backing off from a previous failure (429 or a dead login) — skip
  //    the network entirely. This check must run before getOauthToken(): an
  //    expired refresh token would otherwise be re-submitted to the OAuth
  //    endpoint on every tick (once a minute from the daemon), which the
  //    backoff exists to prevent.
  if (cache && Number.isFinite(retryAt) && retryAt > now) {
    if (cacheIsFresh && cache?.usage) {
      return buildBuckets(
        cache.usage,
        cache.source,
        cache.fetched_at,
        `cached ${shortTime(cache.fetched_at)} · rate limited`,
      );
    }
    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        tier_type: 'rolling_window',
        reason: `${cache.last_error ?? 'Claude usage rate limited'} — retrying after ${shortTime(cache.retry_at!)}`,
      }),
    ];
  }

  let oauth: string | null = null;
  let authProblem: string | null = null;
  try {
    oauth = await getOauthToken();
  } catch (err) {
    authProblem = (err as Error).message;
    console.warn('[claude] OAuth unavailable:', authProblem);
  }
  const sessionKey = process.env.CLAUDE_SESSION_KEY;
  const orgUuid = readOrgUuid();

  if (!oauth && !(sessionKey && orgUuid)) {
    const reason = authProblem
      ? authProblem
      : !orgUuid
      ? 'no Claude org UUID — log into Claude Code once, or set CLAUDE_ORG_UUID'
      : 'no Claude credential — set CLAUDE_SESSION_KEY (claude.ai cookie) or CLAUDE_CODE_OAUTH_TOKEN';
    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason,
      }),
    ];
  }

  // 2. Poll at most once per MIN_FETCH_INTERVAL_MS, however often the scraper
  //    is invoked. The quota windows move over hours, not seconds.
  const lastGood = cache ? Date.parse(cache.fetched_at) : NaN;
  if (cacheIsFresh && cache?.usage && Number.isFinite(lastGood) && now - lastGood < MIN_FETCH_INTERVAL_MS) {
    return buildBuckets(cache.usage, cache.source, cache.fetched_at, `cached ${shortTime(cache.fetched_at)}`);
  }

  let usage: ClaudeUsageResponse | null = null;
  let source = '';

  try {
    if (oauth) {
      try {
        usage = await fetchOauthUsage(oauth);
      } catch (e) {
        const st = (e as { status?: number }).status;
        // Token rejected despite looking valid (revoked / clock skew): refresh once and retry.
        if ((st === 401 || st === 403) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
          oauth = await getOauthToken(true);
          usage = await fetchOauthUsage(oauth!);
        } else {
          throw e;
        }
      }
      source = 'OAuth (Claude Code token)';
    } else if (sessionKey && orgUuid) {
      usage = await fetchWebUsage(sessionKey, orgUuid);
      source = 'claude.ai web session';
    }
  } catch (err) {
    console.warn('[claude] usage fetch failed:', err);

    const status = (err as { status?: number }).status;
    const isAuthFailure = err instanceof ClaudeAuthError || status === 401 || status === 403;
    // 429 needs a real backoff; network errors / 5xx are worth retrying soon.
    const transient = status === 429 || status === undefined || status >= 500;
    // Don't hammer the token endpoint every minute with a dead login.
    const AUTH_BACKOFF_MS = 2 * 60_000;
    const friendly = isAuthFailure
      ? (err instanceof ClaudeAuthError ? err.message : authProblem ?? LOGIN_HINT)
      : undefined;

    writeCache({
      fetched_at: cache?.fetched_at ?? new Date(now).toISOString(),
      source: cache?.source ?? '',
      usage: cache?.usage ?? null,
      retry_at: transient
        ? new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString()
        : isAuthFailure
          ? new Date(now + AUTH_BACKOFF_MS).toISOString()
          : cache?.retry_at,
      last_error: friendly,
    });

    if (transient && cacheIsFresh && cache?.usage) {
      return buildBuckets(
        cache.usage,
        cache.source,
        cache.fetched_at,
        `cached ${shortTime(cache.fetched_at)} · fetch failed`,
      );
    }

    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        tier_type: 'rolling_window',
        reason: friendly ?? `Claude usage fetch failed — ${(err as Error).message}`,
      }),
    ];
  }

  if (!usage) {
    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason: 'no Claude credential — set CLAUDE_SESSION_KEY (claude.ai cookie) or CLAUDE_CODE_OAUTH_TOKEN',
      }),
    ];
  }

  const fetchedAt = new Date(now).toISOString();
  writeCache({ fetched_at: fetchedAt, source, usage });

  const buckets = buildBuckets(usage, source, fetchedAt);
  if (buckets.length === 0) {
    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason: 'Claude reported no plan windows for this account',
      }),
    ];
  }

  return buckets;
}
