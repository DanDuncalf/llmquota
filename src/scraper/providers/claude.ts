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
import { execFile } from 'node:child_process';
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

/** Read a Claude Code OAuth access token from env or the on-disk credential store. */
function readOauthToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const raw = fs.readFileSync(CLAUDE_CREDENTIALS(), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    // expiresAt is epoch-ms; treat as expired if past (the CLI refreshes it).
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      console.warn('[claude] stored OAuth token is expired — run `claude` to refresh it');
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
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
    throw new Error(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
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
    last_updated: new Date().toISOString(),
    notes: note,
  };
}

export async function scrapeClaude(): Promise<RawBucket[]> {
  const oauth = readOauthToken();
  const sessionKey = process.env.CLAUDE_SESSION_KEY;
  const orgUuid = readOrgUuid();

  let usage: ClaudeUsageResponse | null = null;
  let source = '';

  try {
    if (oauth) {
      usage = await fetchOauthUsage(oauth);
      source = 'OAuth (Claude Code token)';
    } else if (sessionKey && orgUuid) {
      usage = await fetchWebUsage(sessionKey, orgUuid);
      source = 'claude.ai web session';
    }
  } catch (err) {
    console.warn('[claude] usage fetch failed:', err);
    return [
      unavailableBucket({
        model_id: 'claude-usage',
        provider: 'anthropic',
        display_name: 'Claude',
        tier_type: 'rolling_window',
        reason: `Claude usage fetch failed — ${(err as Error).message}`,
      }),
    ];
  }

  if (!usage) {
    const reason = !orgUuid
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

  const buckets: RawBucket[] = [];

  if (usage.five_hour) {
    buckets.push(
      windowBucket(
        'claude-5h',
        '5h session',
        'Claude · 5-hour session',
        'rolling_window',
        5,
        usage.five_hour,
        source,
      ),
    );
  }
  if (usage.seven_day) {
    buckets.push(
      windowBucket(
        'claude-weekly',
        'Weekly',
        'Claude · Weekly (all models)',
        'periodic_fixed',
        168,
        usage.seven_day,
        source,
      ),
    );
  }

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
