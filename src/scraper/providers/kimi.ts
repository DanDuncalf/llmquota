// =============================================================================
// Moonshot / Kimi Code scraper  (Kimi Code Plan)
// =============================================================================
//   GET https://api.kimi.com/coding/v1/usages
//   Authorization: Bearer <KIMI_API_KEY>      (a Kimi *Code* key: sk-kimi-…)
//
// Response gives both a clean normalized form and raw windows:
//
//   "usages": {
//     "limit_5h": { "used_ratio": 0.3281, "reset_time": "…Z" },
//     "limit_7d": { "used_ratio": 0.152,  "reset_time": "…Z" }
//   }
//
// The same response also carries the backup wallet used when the plan runs
// out (booster_wallet). Its balance amounts are micro-cents, i.e. 1e-8 USD
// (amount 1e9 = $10.00), NOT micro-USD — dividing by 1e6 overstates the
// wallet by 100x. The separate `monthlyUsed.priceInCents` is plain cents:
//
//   "booster_wallet": {
//     "balance": { "amount": "1000000000", "amountLeft": "465710000",
//                  "unit": "UNIT_CURRENCY" },
//     "monthlyUsed": { "currency": "USD", "priceInCents": "513" },
//     "allowTopup": true
//   }
//
// We show amountLeft as a metered backup row so the pay-as-you-go fallback is
// visible next to the plan windows.
//
// We prefer `usages` (used_ratio is already 0-1) and fall back to
// `limits[]` + `usage` (string limit/used) for older/newer shapes.
//
// Credentials: a KIMI_API_KEY / MOONSHOT_API_KEY (Kimi *Code* key, sk-kimi-…)
// is used if set. Otherwise we read the Kimi Code CLI's own OAuth login from
// <data-root>/credentials/kimi-code.json — the stored access token is itself
// accepted as Bearer here, and the scraper refreshes it via the CLI's OAuth
// endpoint when it has expired (see below). That is what keeps this card alive
// when no Kimi session has run for a while: the env var KIMI_API_KEY only
// exists inside a live Kimi session, but the CLI's credential file persists.
//
// NOTE: Kimi *Code* keys only work against api.kimi.com/coding/v1 — a
// platform.moonshot.ai key returns 401 here.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const ENDPOINT = process.env.KIMI_USAGE_ENDPOINT ?? 'https://api.kimi.com/coding/v1/usages';

interface RatioWindow {
  used_ratio: number;
  reset_time?: string;
}

interface RawWindow {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiUsageResponse {
  usages?: {
    limit_5h?: RatioWindow;
    limit_7d?: RatioWindow;
    [key: string]: RatioWindow | undefined;
  };
  usage?: RawWindow;
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: RawWindow;
  }>;
  booster_wallet?: BoosterWallet;
}

interface Money {
  currency?: string;
  priceInCents?: string | number;
}

interface BoosterWallet {
  balance?: {
    feature?: string;
    type?: string;
    amount?: string | number;
    amountLeft?: string | number;
    unit?: string;
    periodStart?: string;
    periodEnd?: string;
  };
  status?: string;
  allowTopup?: boolean;
  topupLimit?: Money;
  monthlyUsed?: Money;
}

// 1 unit = 1e-6 cent = 1e-8 USD  →  100,000,000 units per dollar.
const WALLET_UNITS_PER_USD = 100_000_000;

function usdFromWalletUnits(v: string | number | undefined): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round((n / WALLET_UNITS_PER_USD) * 100) / 100;
}

function usdFromCents(v: string | number | undefined): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n) / 100;
}

function usd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resetSeconds(iso: string | undefined): { seconds: number; at?: string } {
  if (!iso) return { seconds: 0 };
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { seconds: 0 };
  return { seconds: Math.max(0, Math.round((ts - Date.now()) / 1000)), at: iso };
}

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function rawToPct(w: RawWindow): number {
  const limit = num(w.limit);
  const used = num(w.used);
  if (limit <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (used / limit) * 100)) * 10) / 10;
}

function ratioToPct(r: number): number {
  return Math.round(Math.max(0, Math.min(100, r * 100)) * 10) / 10;
}

function bucket(
  modelId: string,
  windowLabel: string,
  displayName: string,
  tier: 'rolling_window' | 'periodic_fixed',
  hours: number,
  usedPct: number,
  resetIso: string | undefined,
  limitLabel = 'Code Plan',
): RawBucket {
  const { seconds, at } = resetSeconds(resetIso);
  return {
    model_id: modelId,
    provider: 'moonshot',
    display_name: displayName,
    window_label: windowLabel,
    tier_type: tier,
    capacity: {
      used_pct: usedPct,
      reset_in_seconds: seconds,
      limit_window_hours: hours,
      resets_at: at,
      limit_label: limitLabel,
    },
    last_updated: new Date().toISOString(),
    notes: limitLabel,
  };
}

// -----------------------------------------------------------------------------
// OAuth credential file (self-refreshing), mirroring the Claude scraper
// -----------------------------------------------------------------------------
// The Kimi Code CLI stores its login as
// {access_token, refresh_token, expires_at, scope, token_type, expires_in} in
// <data-root>/credentials/kimi-code.json, where data-root is $KIMI_CODE_HOME,
// ~/.kimi-code (current default), or ~/.kimi (legacy — this machine's CLI
// still writes here). Access tokens live only ~15 min and are normally
// refreshed by the CLI while a session runs; with no session running the file
// goes stale, so we refresh it ourselves and write the rotated pair back
// atomically. Refresh tokens ROTATE (the old one dies on use), hence the
// lock file: the daemon and one-shot scrapes can run concurrently, and so can
// a live Kimi session — re-read under the lock and refresh only when still
// stale. The client id is the CLI's public installed-app id; no secret.
const OAUTH_TOKEN_URL = `${(
  process.env.KIMI_CODE_OAUTH_HOST ??
  process.env.KIMI_OAUTH_HOST ??
  'https://auth.kimi.com'
).replace(/\/+$/, '')}/api/oauth/token`;
const OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const REFRESH_SKEW_MS = 2 * 60_000;
const REFRESH_LOCK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/kimi-refresh.lock',
);
const LOGIN_HINT = 'Kimi login expired — run `kimi` and /login once';

interface KimiCredentialFile {
  file: string;
  data: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
    token_type?: string;
    expires_in?: number;
    [k: string]: unknown;
  };
}

function kimiCredentialPaths(): string[] {
  if (process.env.KIMI_CREDENTIALS_PATH) return [process.env.KIMI_CREDENTIALS_PATH];
  const paths: string[] = [];
  if (process.env.KIMI_CODE_HOME) {
    paths.push(path.join(process.env.KIMI_CODE_HOME, 'credentials', 'kimi-code.json'));
  }
  paths.push(path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json'));
  paths.push(path.join(os.homedir(), '.kimi', 'credentials', 'kimi-code.json'));
  return paths;
}

/** First credential file that actually holds a token (some slots are emptied
 *  leftovers from the CLI's data-root migration — existence alone proves
 *  nothing). */
function readKimiCredential(): KimiCredentialFile | null {
  for (const file of kimiCredentialPaths()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as KimiCredentialFile['data'];
      if (data.access_token || data.refresh_token) return { file, data };
    } catch { /* missing or unparseable — try the next candidate */ }
  }
  return null;
}

function writeKimiCredential(cred: KimiCredentialFile): void {
  const tmp = `${cred.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cred.data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, cred.file);
}

function tokenIsFresh(data: KimiCredentialFile['data']): boolean {
  return (
    !!data.access_token &&
    (data.expires_at === undefined || data.expires_at * 1000 - REFRESH_SKEW_MS > Date.now())
  );
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
      try {
        if (Date.now() - fs.statSync(REFRESH_LOCK_PATH).mtimeMs > 30_000) {
          fs.rmSync(REFRESH_LOCK_PATH, { force: true });
        }
      } catch { /* raced with the holder releasing it */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for Kimi token refresh lock');
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmSync(REFRESH_LOCK_PATH, { force: true }); } catch { /* ignore */ }
  }
}

/** POST form-urlencoded with a hard timeout. fetch is fine here (auth.kimi.com
 *  does not filter TLS fingerprints the way claude.ai does). */
async function postRefreshForm(
  form: string,
): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
      signal: ctrl.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a usable access token from the CLI's credential file, refreshing
 * (and persisting) it when expired or about to be. `force` refreshes even if
 * the stored token looks fresh — used after the usage API rejected it with
 * 401. Throws when a login exists but cannot be refreshed.
 */
async function resolveKimiAccessToken(force: boolean): Promise<string> {
  const first = readKimiCredential();
  if (!first) throw new Error('no Kimi Code credential file found (run `kimi` to log in)');
  if (!force && tokenIsFresh(first.data)) return first.data.access_token!;
  if (!first.data.refresh_token) throw new Error(`${LOGIN_HINT} (no refresh token stored)`);
  const staleAccess = first.data.access_token;

  return withRefreshLock(async () => {
    // A live Kimi session (or a racing scrape) may have refreshed meanwhile.
    const cur = readKimiCredential();
    if (!cur?.data.refresh_token) throw new Error(`${LOGIN_HINT} (no refresh token stored)`);
    if (tokenIsFresh(cur.data) && (!force || cur.data.access_token !== staleAccess)) {
      return cur.data.access_token!;
    }

    const form = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: cur.data.refresh_token,
    }).toString();
    const { status, body } = await postRefreshForm(form);

    if (status < 200 || status >= 300) {
      console.warn(`[kimi] token refresh failed: HTTP ${status}: ${body.slice(0, 200)}`);
      if (status === 400 || status === 401) {
        throw new Error(`${LOGIN_HINT} (refresh rejected, HTTP ${status})`);
      }
      throw new Error(`Kimi token refresh failed: HTTP ${status}`);
    }

    const tok = JSON.parse(body) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!tok.access_token) throw new Error('Kimi token refresh returned no access_token');

    cur.data = {
      ...cur.data,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? cur.data.refresh_token,
      // the CLI writes expires_at as float epoch seconds — keep that shape
      expires_at: Date.now() / 1000 + (tok.expires_in ?? cur.data.expires_in ?? 900),
      ...(tok.scope !== undefined ? { scope: tok.scope } : {}),
      ...(tok.token_type !== undefined ? { token_type: tok.token_type } : {}),
      ...(tok.expires_in !== undefined ? { expires_in: tok.expires_in } : {}),
    };
    // Persist BEFORE using it: the old refresh token is already dead.
    writeKimiCredential(cur);
    console.log('[kimi] OAuth token refreshed; expires', new Date(cur.data.expires_at! * 1000).toISOString());
    return cur.data.access_token!;
  });
}

export async function scrapeKimi(): Promise<RawBucket[]> {
  let apiKey = process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  let oauthMode = false;
  if (!apiKey) {
    if (!readKimiCredential()) {
      return [
        unavailableBucket({
          model_id: 'kimi-usage',
          provider: 'moonshot',
          display_name: 'Kimi',
          window_label: 'plan windows',
          tier_type: 'rolling_window',
          reason: 'no KIMI_API_KEY set and no Kimi Code credential file found (run `kimi` to log in)',
        }),
      ];
    }
    oauthMode = true;
    try {
      apiKey = await resolveKimiAccessToken(false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[kimi]', reason);
      return [
        unavailableBucket({
          model_id: 'kimi-usage',
          provider: 'moonshot',
          display_name: 'Kimi',
          window_label: 'plan windows',
          tier_type: 'rolling_window',
          reason,
        }),
      ];
    }
  }

  let data: KimiUsageResponse;
  try {
    data = await fetchUsage(apiKey);
  } catch (err) {
    // The usage API rejected the token — force-refresh the OAuth login and
    // try exactly once more before giving up for this tick.
    if (oauthMode && err instanceof HttpError && err.status === 401) {
      try {
        apiKey = await resolveKimiAccessToken(true);
        data = await fetchUsage(apiKey);
      } catch (retryErr) {
        return [kimiUnavailable(retryErr)];
      }
    } else {
      return [kimiUnavailable(err)];
    }
  }

  const buckets: RawBucket[] = [];
  const u = data.usages;

  if (u?.limit_5h) {
    buckets.push(
      bucket('kimi-5h', '5h session', 'Moonshot · 5-hour session', 'rolling_window', 5, ratioToPct(u.limit_5h.used_ratio), u.limit_5h.reset_time, 'Code Plan'),
    );
  }
  if (u?.limit_7d) {
    buckets.push(
      bucket('kimi-weekly', 'Weekly', 'Moonshot · Weekly', 'periodic_fixed', 168, ratioToPct(u.limit_7d.used_ratio), u.limit_7d.reset_time, 'Code Plan'),
    );
  }

  // Fallback for shapes without `usages`.
  // Backup wallet: the USD balance Kimi uses after the plan allowance is spent.
  const wallet = data.booster_wallet;
  const walletBalance = wallet?.balance;
  if (
    walletBalance?.unit === 'UNIT_CURRENCY' &&
    (walletBalance.amountLeft !== undefined || walletBalance.amount !== undefined)
  ) {
    const left = usdFromWalletUnits(walletBalance.amountLeft);
    const reserved = usdFromWalletUnits(walletBalance.amount);
    const monthlyUsed = usdFromCents(wallet?.monthlyUsed?.priceInCents);

    const details = [
      reserved !== undefined ? `$${usd(reserved)} reserved` : undefined,
      monthlyUsed !== undefined ? `$${usd(monthlyUsed)} used ${currentPeriod()}` : undefined,
    ].filter(Boolean);

    if (left !== undefined) {
      buckets.push({
        model_id: 'kimi-backup',
        provider: 'moonshot',
        display_name: 'Kimi · Booster wallet (backup)',
        window_label: 'backup balance',
        tier_type: 'metered',
        capacity: {
          used_pct: 0,
          reset_in_seconds: 0,
          balance_usd: left,
          limit_label: details.join(' · '),
        },
        last_updated: new Date().toISOString(),
        notes: 'Kimi backup balance (used after the plan quota)',
      });
    }
  }

  if (buckets.length === 0) {
    const short = data.limits?.[0];
    if (short?.detail) {
      const mins = short.window?.duration ?? 300;
      buckets.push(
        bucket('kimi-5h', '5h session', 'Moonshot · 5-hour session', 'rolling_window', Math.round((mins / 60) * 10) / 10, rawToPct(short.detail), short.detail.resetTime, 'Code Plan'),
      );
    }
    if (data.usage) {
      buckets.push(
        bucket('kimi-weekly', 'Weekly', 'Moonshot · Weekly', 'periodic_fixed', 168, rawToPct(data.usage), data.usage.resetTime, 'Code Plan'),
      );
    }
  }

  if (buckets.length === 0) {
    return [
      unavailableBucket({
        model_id: 'kimi-usage',
        provider: 'moonshot',
        display_name: 'Kimi',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason: 'Kimi returned no usage windows for this account',
      }),
    ];
  }

  return buckets;
}

function fetchUsage(apiKey: string): Promise<KimiUsageResponse> {
  return httpJson<KimiUsageResponse>(ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

function kimiUnavailable(err: unknown): RawBucket {
  const reason =
    err instanceof HttpError && err.status === 401 && !process.env.KIMI_API_KEY && !process.env.MOONSHOT_API_KEY
      ? 'Kimi OAuth token rejected — is the Kimi Code login still valid?'
      : err instanceof HttpError && err.status === 401
        ? 'Kimi Code key rejected (need a Kimi Code key, sk-kimi-…)'
        : `Kimi usage fetch failed — ${(err as Error).message}`;
  console.warn('[kimi]', reason);
  return unavailableBucket({
    model_id: 'kimi-usage',
    provider: 'moonshot',
    display_name: 'Kimi',
    window_label: 'plan windows',
    tier_type: 'rolling_window',
    reason,
  });
}
