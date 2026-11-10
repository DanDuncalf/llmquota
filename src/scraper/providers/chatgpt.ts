// =============================================================================
// OpenAI / ChatGPT scraper  (ChatGPT Plus / Pro rate-limit windows)
// =============================================================================
// ChatGPT has no public quota API. The Codex CLI polls an internal endpoint and
// stores the OAuth session in ~/.codex/auth.json (written by `codex login`) —
// we reuse exactly that:
//
//   GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <tokens.access_token>
//   ChatGPT-Account-Id: <tokens.account_id>
//
// Response (relevant parts):
//   { plan_type, rate_limit: { allowed, limit_reached,
//       primary_window:   { used_percent, limit_window_seconds, reset_at },
//       secondary_window: { used_percent, limit_window_seconds, reset_at } | null } }
//   where reset_at is epoch SECONDS.
//
// IMPORTANT: which window sits where depends on the plan. Plus/Pro used to
// report 5h in `primary_window` and 7d in `secondary_window`; other plans (e.g.
// `prolite`) report ONLY the 7d window, in `primary_window`, with
// `secondary_window: null`. So never label by position — always derive the
// label from `limit_window_seconds` (see describeWindow).
//
// Banked resets ("usage limit resets") come from a sibling endpoint:
//   GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
//   → { credits: [{ id, title, description, status,
//                   granted_at, expires_at, ... }], available_count }
// Only `status: "available"` credits are surfaced, with their expiry dates.
// A failure here never fails the quota card — it just hides the resets block.

// Token handling: OpenAI *rotates* refresh tokens, so we never refresh unless
// you explicitly opt in with CODEX_ENABLE_REFRESH=1 (we then write the rotated
// tokens back to auth.json, exactly like codex does). Otherwise an expired
// token simply marks the card unavailable with "run `codex login`".
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const authPath = () =>
  process.env.CODEX_AUTH_PATH ?? path.join(os.homedir(), '.codex', 'auth.json');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';

interface Window {
  used_percent: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number; // epoch seconds
}

interface WhamUsage {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: Window | null;
    secondary_window?: Window | null;
  } | null;
  credits?: { has_credits?: boolean; balance?: string } | null;
  rate_limit_reset_credits?: { available_count?: number } | null;
}

interface ResetCredit {
  id: string;
  reset_type?: string;
  is_supported_by_plan?: boolean;
  status?: string;
  granted_at?: string;
  expires_at?: string;
  title?: string;
  description?: string;
}

interface WhamResetCredits {
  credits?: ResetCredit[] | null;
  available_count?: number;
}

interface AuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function readAuth(): AuthFile | null {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf8')) as AuthFile;
  } catch {
    return null;
  }
}

/** Decode a JWT payload without verifying (we only need `exp`). */
function jwtExpMs(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number };
    return json.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(token: string): boolean {
  const exp = jwtExpMs(token);
  return exp !== null && Date.now() > exp;
}

/** Opt-in refresh; persists rotated tokens back to auth.json (atomic + backup). */
async function refreshTokens(auth: AuthFile): Promise<AuthFile> {
  const refresh = auth.tokens?.refresh_token;
  if (!refresh) throw new Error('no refresh_token in auth.json');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refresh,
  });
  const res = await httpJson<{
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  }>(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const next: AuthFile = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: res.access_token,
      refresh_token: res.refresh_token ?? refresh,
      id_token: res.id_token ?? auth.tokens?.id_token,
    },
    last_refresh: new Date().toISOString(),
  };

  try {
    if (!fs.existsSync(`${authPath()}.bak-quota-dashboard`)) {
      fs.copyFileSync(authPath(), `${authPath()}.bak-quota-dashboard`);
    }
    const tmp = `${authPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, authPath());
  } catch (err) {
    console.warn('[chatgpt] could not persist refreshed tokens:', err);
  }
  return next;
}

function resetInfo(w: Window | null | undefined): { seconds: number; at?: string } {
  if (!w) return { seconds: 0 };
  if (typeof w.reset_at === 'number') {
    const seconds = Math.max(0, w.reset_at - Math.floor(Date.now() / 1000));
    return { seconds, at: new Date(w.reset_at * 1000).toISOString() };
  }
  if (typeof w.reset_after_seconds === 'number') {
    return {
      seconds: w.reset_after_seconds,
      at: new Date(Date.now() + w.reset_after_seconds * 1000).toISOString(),
    };
  }
  return { seconds: 0 };
}

function windowBucket(
  modelId: string,
  windowLabel: string,
  displayName: string,
  tier: 'rolling_window' | 'periodic_fixed',
  w: Window,
  note: string,
): RawBucket {
  const { seconds, at } = resetInfo(w);
  const hours = w.limit_window_seconds ? Math.round((w.limit_window_seconds / 3600) * 10) / 10 : undefined;
  return {
    model_id: modelId,
    provider: 'openai',
    display_name: displayName,
    window_label: windowLabel,
    tier_type: tier,
    capacity: {
      used_pct: Math.round(Math.max(0, Math.min(100, w.used_percent)) * 10) / 10,
      reset_in_seconds: seconds,
      limit_window_hours: hours,
      resets_at: at,
      limit_label: note,
    },
    last_updated: new Date().toISOString(),
    notes: note,
  };
}

/**
 * Fetch banked reset credits, keeping only usable ones and sorting so the
 * soonest-expiring credit comes first. Throws on network/HTTP errors; callers
 * treat that as "no credits shown".
 */
async function fetchResetCredits(headers: Record<string, string>): Promise<ResetCredit[]> {
  const res = await httpJson<WhamResetCredits>(RESET_CREDITS_URL, { headers });
  const now = Date.now();
  return (res.credits ?? [])
    .filter((c) => c.status === 'available' && c.id)
    .filter((c) => !c.expires_at || Date.parse(c.expires_at) > now)
    .sort((a, b) => {
      const at = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
      const bt = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
      return at - bt;
    });
}

interface WindowMeta {
  modelId: string;
  windowLabel: string;
  displayName: string;
  tier: 'rolling_window' | 'periodic_fixed';
}

const PLAN_NAMES: Record<string, string> = {
  prolite: 'Pro Lite',
  plus: 'Plus',
  pro: 'Pro',
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
  business: 'Business',
};

function planName(raw: string | undefined): string {
  if (!raw) return 'ChatGPT';
  return PLAN_NAMES[raw.toLowerCase()] ?? raw[0].toUpperCase() + raw.slice(1);
}

/**
 * Name a rate-limit window from its actual length, not its position in the
 * response. Weekly windows are the ones that matter for 7d caps; anything else
 * gets a neutral "<n>h window" label so a plan change can never mislabel it.
 */
function describeWindow(w: Window, plan: string): WindowMeta {
  const hours = w.limit_window_seconds ? w.limit_window_seconds / 3600 : undefined;
  if (hours !== undefined && hours >= 24 * 6) {
    return {
      modelId: 'chatgpt-weekly',
      windowLabel: 'Weekly',
      displayName: `ChatGPT ${plan} · Weekly`,
      tier: 'periodic_fixed',
    };
  }
  if (hours !== undefined && hours <= 8) {
    return {
      modelId: 'chatgpt-5h',
      windowLabel: '5h session',
      displayName: `ChatGPT ${plan} · 5-hour session`,
      tier: 'rolling_window',
    };
  }
  const label = hours !== undefined ? `${Math.round(hours * 10) / 10}h window` : 'rate-limit window';
  return {
    modelId: hours !== undefined ? `chatgpt-${Math.round(hours * 10) / 10}h` : 'chatgpt-window',
    windowLabel: label,
    displayName: `ChatGPT ${plan} · ${label}`,
    tier: 'rolling_window',
  };
}

function fail(reason: string): RawBucket[] {
  return [
    unavailableBucket({
      model_id: 'chatgpt-usage',
      provider: 'openai',
      display_name: 'ChatGPT',
      window_label: 'rate limits',
      tier_type: 'rolling_window',
      reason,
    }),
  ];
}

export async function scrapeChatGPT(): Promise<RawBucket[]> {
  let auth = readAuth();
  const initialToken = auth?.tokens?.access_token;
  if (!auth || !initialToken) {
    return fail('no Codex auth — run `codex login` (or set OPENAI_SESSION_TOKEN)');
  }

  // Fall back to a browser session token if the user provided one.
  if (process.env.OPENAI_SESSION_TOKEN) {
    auth = { ...auth, tokens: { ...auth.tokens, access_token: process.env.OPENAI_SESSION_TOKEN } };
  }

  let accessToken = auth?.tokens?.access_token ?? initialToken;

  if (isExpired(accessToken)) {
    if (process.env.CODEX_ENABLE_REFRESH === '1') {
      try {
        auth = await refreshTokens(auth as AuthFile);
        accessToken = auth.tokens?.access_token ?? accessToken;
      } catch (err) {
        return fail('Codex token expired and refresh failed — run codex login: ' + (err as Error).message);
      }
    } else {
      return fail('Codex token expired — run `codex login` (or set CODEX_ENABLE_REFRESH=1)');
    }
  }

  const accountId = auth?.tokens?.account_id;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    'User-Agent': 'quota-dashboard/1.0 (personal local usage tracker)',
  };

  let usage: WhamUsage;
  try {
    usage = await httpJson<WhamUsage>(USAGE_URL, { headers });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return fail('Codex session rejected — run `codex login`');
    }
    return fail(`ChatGPT usage fetch failed — ${(err as Error).message}`);
  }

  const rl = usage.rate_limit;
  if (!rl || (!rl.primary_window && !rl.secondary_window)) {
    return fail(`ChatGPT returned no rate-limit windows (plan: ${usage.plan_type ?? 'unknown'})`);
  }

  const plan = planName(usage.plan_type);
  const buckets: RawBucket[] = [];

  // Shortest window first (5h before daily/weekly), deduped by derived id, so
  // whichever slots the API populates the card still shows every window once.
  const windows = [rl.primary_window, rl.secondary_window]
    .filter((w): w is Window => Boolean(w))
    .sort((a, b) => (a.limit_window_seconds ?? 0) - (b.limit_window_seconds ?? 0));

  const seen = new Set<string>();
  for (const w of windows) {
    const meta = describeWindow(w, plan);
    if (seen.has(meta.modelId)) continue;
    seen.add(meta.modelId);
    buckets.push(
      windowBucket(meta.modelId, meta.windowLabel, meta.displayName, meta.tier, w, `${plan} plan`),
    );
  }

  // Banked resets: attach the itemised credits (with expiry) to one bucket so
  // the UI can show when each one lapses. Keep the count note as a fallback if
  // the credits endpoint is unavailable.
  let credits: ResetCredit[] = [];
  try {
    credits = await fetchResetCredits(headers);
  } catch (err) {
    console.warn('[chatgpt] reset-credits fetch failed:', (err as Error).message);
  }

  const availableCount = credits.length || usage.rate_limit_reset_credits?.available_count;
  if (typeof availableCount === 'number') {
    for (const b of buckets) {
      b.notes = `${b.notes ?? ''} · ${availableCount} banked reset${availableCount === 1 ? '' : 's'}`.trim();
    }
  }
  if (credits.length > 0) {
    buckets[0].reset_credits = credits.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      status: c.status,
      reset_type: c.reset_type,
      granted_at: c.granted_at,
      expires_at: c.expires_at,
    }));
  }

  return buckets;
}
