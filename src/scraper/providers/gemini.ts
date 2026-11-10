// =============================================================================
// Google Gemini scraper  (Code Assist quota, one card per Google account)
// =============================================================================
// Google retired Gemini CLI's individual (free) tier — a personal OAuth token
// now gets UNSUPPORTED_CLIENT from loadCodeAssist. The same Code Assist quota is
// still served to the Antigravity client, so each linked account records which
// OAuth client it belongs to:
//
//   client: "antigravity"  → Antigravity OAuth client (default for new links)
//   client: "gemini"       → Gemini CLI OAuth client (legacy / paid GCP projects)
//
// Credentials live in Gemini CLI's own format at:
//
//   <GEMINI_CLI_HOME>/.gemini/oauth_creds.json
//   { access_token, refresh_token, expiry_date, id_token?, scope, token_type }
//
// Endpoints (Cloud Code Assist):
//   POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
//   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
//
// retrieveUserQuota returns the real per-model buckets; models in a pool share
// one weekly limit, so we collapse them to one row per pool. The summary is kept
// as a fallback for legacy Gemini CLI accounts. The daily deployment is the one
// the Antigravity client itself uses — the production deployment can return a
// placeholder "all 100%, resets in 7d" summary for Starter-tier accounts, which
// must not be trusted.
//
// Multi-account: each account gets its own GEMINI_CLI_HOME under
// ~/.gemini-profiles/<slug> (created by `npm run gemini-login -- <email>`).
// Accounts can also be supplied with GEMINI_CLI_HOMES=/home/a,/home/b.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError, clamp, futureIso } from './base.js';

const HOME = os.homedir();
const PROFILE_ROOT = process.env.GEMINI_PROFILE_ROOT ?? path.join(HOME, '.gemini-profiles');
const DEFAULT_CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';
const DAILY_CODE_ASSIST = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Both clients are public installed-app clients (embedded in the open-source
// CLIs); the client IDs are public and the "secrets" are not confidential. They
// still stay out of this repo because GitHub secret scanning blocks them, so
// the secrets come from .env (see .env.example).
const CLIENTS = {
  gemini: {
    id:
      process.env.GEMINI_OAUTH_CLIENT_ID ??
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    secret: process.env.GEMINI_OAUTH_CLIENT_SECRET,
    secretVar: 'GEMINI_OAUTH_CLIENT_SECRET',
  },
  antigravity: {
    id:
      process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ??
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    secretVar: 'ANTIGRAVITY_OAUTH_CLIENT_SECRET',
  },
} as const;

const DEFAULT_RESET_SECONDS = 24 * 3600;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export type GeminiClientKind = keyof typeof CLIENTS;

export interface GeminiAccount {
  id: string;
  email: string;
  /** GEMINI_CLI_HOME for this account (contains .gemini/oauth_creds.json). */
  home: string;
  credsPath: string;
  client: GeminiClientKind;
  /** Optional GCP project override from profile.json. */
  project?: string;
}

interface OauthCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

interface ProfileFile {
  email?: string;
  client?: GeminiClientKind;
  project?: string;
}

interface GeminiTier {
  id?: string;
  name?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistResponse {
  currentTier?: GeminiTier | null;
  paidTier?: GeminiTier | null;
  allowedTiers?: GeminiTier[] | null;
  cloudaicompanionProject?: string | null;
  ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string }> | null;
}

interface BucketInfo {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
  bucketId?: string;
  displayName?: string;
  window?: string;
}

interface QuotaSummaryGroup {
  displayName?: string;
  description?: string;
  buckets?: BucketInfo[];
}

interface RetrieveUserQuotaSummaryResponse {
  groups?: QuotaSummaryGroup[];
}

interface RetrieveUserQuotaResponse {
  buckets?: BucketInfo[];
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function jwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailFromCreds(creds: OauthCreds | null): string | undefined {
  const payload = jwtPayload(creds?.id_token);
  const email = payload?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

function slugFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
}

function accountFromHome(home: string, meta?: ProfileFile | null): GeminiAccount | null {
  const credsPath = path.join(home, '.gemini', 'oauth_creds.json');
  const creds = readJson<OauthCreds>(credsPath);
  const email = meta?.email ?? emailFromCreds(creds);
  if (!email) return null;
  return {
    id: slugFromEmail(email),
    email,
    home,
    credsPath,
    client: meta?.client ?? 'gemini',
    project: meta?.project,
  };
}

/**
 * Every Gemini account the dashboard knows about:
 *   * explicit GEMINI_CLI_HOMES entries (comma separated),
 *   * the default CLI home (~/.gemini),
 *   * each profile under GEMINI_PROFILE_ROOT (created by gemini-login).
 * Profiles without credentials are listed too (profile.json metadata), so their
 * cards explain how to sign in instead of disappearing.
 */
export function discoverGeminiAccounts(): GeminiAccount[] {
  const homes: string[] = [];

  const explicit = process.env.GEMINI_CLI_HOMES?.trim();
  if (explicit) {
    for (const h of explicit.split(',')) {
      const trimmed = h.trim();
      if (trimmed) homes.push(path.resolve(trimmed));
    }
  }

  // Profiles created by gemini-login win over the default ~/.gemini home: a
  // stale Gemini CLI login there must not shadow the Antigravity profile.
  try {
    for (const entry of fs.readdirSync(PROFILE_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(path.join(PROFILE_ROOT, entry.name));
    }
  } catch {
    /* no profiles yet */
  }

  homes.push(HOME); // default GEMINI_CLI_HOME, lowest priority

  const byEmail = new Map<string, GeminiAccount>();
  for (const home of homes) {
    const meta = readJson<ProfileFile>(path.join(home, 'profile.json'));
    const acct = accountFromHome(home, meta);
    if (!acct) continue;
    const existing = byEmail.get(acct.email);
    if (!existing || (!fs.existsSync(existing.credsPath) && fs.existsSync(acct.credsPath))) {
      byEmail.set(acct.email, acct);
    }
  }

  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// -----------------------------------------------------------------------------
// Credentials + refresh
// -----------------------------------------------------------------------------
function persistCreds(acct: GeminiAccount, creds: OauthCreds): void {
  try {
    fs.mkdirSync(path.dirname(acct.credsPath), { recursive: true });
    if (fs.existsSync(acct.credsPath) && !fs.existsSync(`${acct.credsPath}.bak-quota-dashboard`)) {
      fs.copyFileSync(acct.credsPath, `${acct.credsPath}.bak-quota-dashboard`);
    }
    const tmp = `${acct.credsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, acct.credsPath);
  } catch (err) {
    console.warn(`[gemini] could not persist refreshed credentials for ${acct.email}:`, err);
  }
}

function projectOverride(acct: GeminiAccount): string | undefined {
  const map = process.env.GEMINI_ACCOUNT_PROJECTS;
  if (map) {
    for (const pair of map.split(',')) {
      const [email, project] = pair.split('=').map((s) => s.trim());
      if (email && project && email.toLowerCase() === acct.email.toLowerCase()) return project;
    }
  }
  const envKey = `GEMINI_PROJECT_${acct.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return acct.project ?? process.env[envKey] ?? process.env.GOOGLE_CLOUD_PROJECT;
}

async function refreshAccessToken(acct: GeminiAccount, creds: OauthCreds): Promise<OauthCreds> {
  if (!creds.refresh_token) {
    throw new Error('no refresh token — run `npm run gemini-login -- ' + acct.email + '`');
  }
  const client = CLIENTS[acct.client];
  if (!client.secret) {
    throw new Error(`${client.secretVar} is not set — cannot refresh the ${acct.client} token`);
  }
  const body = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });

  let res: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    token_type?: string;
  };
  try {
    res = await httpJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
      throw new Error(
        'refresh token rejected — sign in again with `npm run gemini-login -- ' + acct.email + '`',
      );
    }
    throw err;
  }

  const next: OauthCreds = {
    ...creds,
    access_token: res.access_token,
    expiry_date: Date.now() + res.expires_in * 1000,
    refresh_token: res.refresh_token ?? creds.refresh_token,
    id_token: res.id_token ?? creds.id_token,
    scope: res.scope ?? creds.scope,
    token_type: res.token_type ?? creds.token_type ?? 'Bearer',
  };
  persistCreds(acct, next);
  return next;
}

async function accessToken(acct: GeminiAccount, forceRefresh = false): Promise<string> {
  let creds = readJson<OauthCreds>(acct.credsPath);
  if (!creds?.access_token && !creds?.refresh_token) {
    throw new Error(`not signed in — run \`npm run gemini-login -- ${acct.email}\``);
  }

  const expired =
    !creds.access_token ||
    (typeof creds.expiry_date === 'number' && creds.expiry_date - 60_000 < Date.now());

  if (forceRefresh || expired) {
    creds = await refreshAccessToken(acct, creds);
  }
  return creds.access_token as string;
}

// -----------------------------------------------------------------------------
// Code Assist calls
// -----------------------------------------------------------------------------
function requestHeaders(acct: GeminiAccount, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': acct.client === 'antigravity' ? 'antigravity' : 'quota-dashboard/1.0',
  };
}

async function codeAssistPost<T>(
  acct: GeminiAccount,
  token: string,
  base: string,
  method: string,
  body: object,
): Promise<T> {
  return httpJson<T>(`${base}:${method}`, {
    method: 'POST',
    headers: requestHeaders(acct, token),
    body: JSON.stringify(body),
  });
}

async function withAuthRetry<T>(
  acct: GeminiAccount,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  let token = await accessToken(acct);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      token = await accessToken(acct, true);
      return fn(token);
    }
    throw err;
  }
}

function loadMetadata(acct: GeminiAccount, project?: string): object {
  if (acct.client === 'antigravity') {
    return {
      ideType: 'ANTIGRAVITY',
      ideName: 'antigravity',
      platform: 'WINDOWS_AMD64',
      pluginType: 'GEMINI',
      ...(project ? { duetProject: project } : {}),
    };
  }
  return {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    ...(project ? { duetProject: project } : {}),
  };
}

async function loadAssistPlan(
  acct: GeminiAccount,
): Promise<{ project?: string; tier: string }> {
  const projectHint = projectOverride(acct);
  const res = await withAuthRetry(acct, (token) =>
    codeAssistPost<LoadCodeAssistResponse>(acct, token, DEFAULT_CODE_ASSIST, 'loadCodeAssist', {
      ...(projectHint ? { cloudaicompanionProject: projectHint } : {}),
      metadata: loadMetadata(acct, projectHint),
    }),
  );

  const tier =
    res.paidTier?.name ??
    res.currentTier?.name ??
    res.paidTier?.id ??
    res.currentTier?.id ??
    'Gemini Code Assist';

  const project = projectHint ?? res.cloudaicompanionProject ?? undefined;
  return { project, tier };
}

async function fetchQuotaSummary(
  acct: GeminiAccount,
  project: string | undefined,
): Promise<RetrieveUserQuotaSummaryResponse> {
  const body = project ? { project } : {};
  // Prefer the production deployment; the daily one sometimes omits a group.
  const hosts = [DEFAULT_CODE_ASSIST, DAILY_CODE_ASSIST];
  let lastErr: unknown;

  for (const base of hosts) {
    try {
      const res = await withAuthRetry(acct, (token) =>
        codeAssistPost<RetrieveUserQuotaSummaryResponse>(
          acct,
          token,
          base,
          'retrieveUserQuotaSummary',
          body,
        ),
      );
      if ((res.groups ?? []).some((g) => (g.buckets ?? []).length > 0)) return res;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return {};
}

async function fetchPerModelQuota(
  acct: GeminiAccount,
  project: string | undefined,
): Promise<RetrieveUserQuotaResponse> {
  const body = project ? { project } : {};
  // Daily first: that is the deployment Antigravity's quota manager polls, and
  // the only one that carries live per-model consumption for Starter accounts.
  const hosts = [DAILY_CODE_ASSIST, DEFAULT_CODE_ASSIST];
  let lastErr: unknown;

  for (const base of hosts) {
    try {
      const res = await withAuthRetry(acct, (token) =>
        codeAssistPost<RetrieveUserQuotaResponse>(acct, token, base, 'retrieveUserQuota', body),
      );
      if ((res.buckets ?? []).length > 0) return res;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return {};
}

// -----------------------------------------------------------------------------
// Presentation
// -----------------------------------------------------------------------------
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Model id → quota pool. Models in a pool share one weekly limit. */
function poolOf(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.startsWith('gemini')) return 'Gemini';
  if (m.startsWith('claude') || m.startsWith('gpt')) return 'Claude';
  return cap(m.split('-')[0] || 'quota');
}

function windowLabel(bucket: BucketInfo): string {
  const raw = `${bucket.window ?? ''} ${bucket.bucketId ?? ''} ${bucket.displayName ?? ''}`.toLowerCase();
  if (raw.includes('week')) return 'Weekly';
  if (raw.includes('5h') || raw.includes('five') || raw.includes('session')) return '5h session';
  if (raw.includes('day') || raw.includes('daily')) return 'Daily';
  return bucket.displayName ?? bucket.window ?? 'quota';
}

function resetSeconds(iso: string | undefined): number {
  if (!iso) return DEFAULT_RESET_SECONDS;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return DEFAULT_RESET_SECONDS;
  return Math.max(0, Math.round((ts - Date.now()) / 1000));
}

function usedPct(bucket: BucketInfo): number {
  const fraction =
    typeof bucket.remainingFraction === 'number' ? clamp(bucket.remainingFraction, 0, 1) : 1;
  return Math.round((1 - fraction) * 1000) / 10;
}

/** Group labels: both pools are reported by their headline model family. */
function poolLabel(group: QuotaSummaryGroup): string {
  const text = `${group.displayName ?? ''} ${group.description ?? ''}`.toLowerCase();
  if (text.includes('gemini')) return 'Gemini';
  if (text.includes('claude') || text.includes('gpt') || text.includes('3p')) return 'Claude';
  return group.displayName?.replace(/\s*models?$/i, '') ?? 'Quota';
}

function summaryBuckets(
  acct: GeminiAccount,
  summary: RetrieveUserQuotaSummaryResponse,
  tier: string,
): RawBucket[] {
  const nowIso = new Date().toISOString();
  const out: RawBucket[] = [];

  for (const group of summary.groups ?? []) {
    const pool = poolLabel(group);
    for (const bucket of group.buckets ?? []) {
      if (typeof bucket.remainingFraction !== 'number') continue;
      const label = windowLabel(bucket);
      const seconds = resetSeconds(bucket.resetTime);
      out.push({
        model_id: `gemini-${acct.id}-${pool.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}`,
        provider: 'gemini',
        account: acct.email,
        display_name: `Antigravity · ${pool} · ${label}`,
        window_label: `${pool} · ${label}`,
        tier_type: 'rolling_window',
        capacity: {
          used_pct: usedPct(bucket),
          reset_in_seconds: seconds,
          resets_at: bucket.resetTime ?? futureIso(seconds),
          limit_label: tier,
        },
        last_updated: nowIso,
        notes: `${acct.email} · ${tier}`,
      });
    }
  }

  return out;
}

function poolBuckets(
  acct: GeminiAccount,
  quota: RetrieveUserQuotaResponse,
  tier: string,
): RawBucket[] {
  // The per-model endpoint reports the same fraction for every model in a
  // pool (Gemini models share one weekly limit; Claude-family and GPT models
  // share another), so collapse them to one row per pool using the
  // most-consumed member.
  const byPool = new Map<string, BucketInfo>();
  for (const b of quota.buckets ?? []) {
    if (!b.modelId) continue;
    // chat_*, tab_* etc. are internal buckets: no reset time, never selectable.
    if (!b.resetTime && (b.remainingFraction ?? 1) >= 1) continue;
    const pool = poolOf(b.modelId);
    const prev = byPool.get(pool);
    const bFrac = b.remainingFraction ?? 1;
    const pFrac = prev?.remainingFraction ?? 1;
    if (!prev || bFrac < pFrac) byPool.set(pool, b);
  }

  const nowIso = new Date().toISOString();
  return [...byPool.entries()]
    .sort(([, a], [, b]) => usedPct(b) - usedPct(a)) // most used first
    .map(([pool, b]) => {
      const seconds = resetSeconds(b.resetTime);
      const remaining = b.remainingAmount ? `${b.remainingAmount} left` : undefined;
      return {
        model_id: `gemini-${acct.id}-${pool.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-weekly`,
        provider: 'gemini',
        account: acct.email,
        display_name: `Antigravity · ${pool} · Weekly`,
        window_label: `${pool} · Weekly`,
        tier_type: 'rolling_window',
        capacity: {
          used_pct: usedPct(b),
          reset_in_seconds: seconds,
          resets_at: b.resetTime ?? futureIso(seconds),
          limit_label: [tier, remaining].filter(Boolean).join(' · '),
        },
        last_updated: nowIso,
        notes: `${acct.email} · ${tier} · ${pool} pool`,
      } satisfies RawBucket;
    });
}

function accountFailure(acct: GeminiAccount, reason: string): RawBucket {
  const bucket = unavailableBucket({
    model_id: `gemini-${acct.id}-quota`,
    provider: 'gemini',
    display_name: 'Antigravity',
    window_label: 'quota',
    tier_type: 'rolling_window',
    reason: `${acct.email}: ${reason}`,
  });
  return { ...bucket, account: acct.email };
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
export async function scrapeGemini(): Promise<RawBucket[]> {
  const accounts = discoverGeminiAccounts();
  if (accounts.length === 0) {
    return [
      unavailableBucket({
        model_id: 'gemini-quota',
        provider: 'gemini',
        display_name: 'Antigravity',
        window_label: 'quota',
        tier_type: 'rolling_window',
        reason: 'no Gemini accounts — run `npm run gemini-login -- <email>` to link one',
      }),
    ];
  }

  const results = await Promise.all(
    accounts.map(async (acct): Promise<RawBucket[]> => {
      if (!fs.existsSync(acct.credsPath)) {
        return [
          accountFailure(acct, `not signed in — run \`npm run gemini-login -- ${acct.email}\``),
        ];
      }
      try {
        const plan = await loadAssistPlan(acct);

        // Per-model buckets are the real source of truth; the group summary is
        // only a fallback (legacy Gemini CLI accounts, or a partial response).
        const perModel = await fetchPerModelQuota(acct, plan.project);
        const rows = poolBuckets(acct, perModel, plan.tier);
        if (rows.length > 0) return rows;

        const summary = await fetchQuotaSummary(acct, plan.project);
        const summaryRows = summaryBuckets(acct, summary, plan.tier);
        if (summaryRows.length > 0) return summaryRows;

        return [accountFailure(acct, 'Code Assist returned no quota buckets')];
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.warn(`[gemini] ${acct.email} failed:`, message);
        return [accountFailure(acct, `quota fetch failed — ${message}`)];
      }
    }),
  );

  return results.flat();
}
