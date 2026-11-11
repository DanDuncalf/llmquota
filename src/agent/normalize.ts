// =============================================================================
// Normalization + query
// =============================================================================
// Turns the dashboard's quota-state shape into the compact JSON an agent can
// reason about:
//
//   dollars_left      prepaid balance in USD (DeepSeek), null when unknown
//   five_hour         used/remaining % + reset for the 5-hour session window
//   weekly            used/remaining % + reset for the weekly window
//   windows           every other window the provider reports
//   models            per-model token usage over 1h / 5h / 24h
//
// Input types are deliberately loose (Partial) so a slightly older state.json
// still answers rather than throwing.
// =============================================================================

import type { TierType, WasteRiskLevel } from '../types/quota.js';
import { PROVIDERS, providerMeta, aliasMatches } from './providers.js';
import type { ProviderMeta } from './providers.js';
import { stateAgeSeconds } from './source.js';

// -----------------------------------------------------------------------------
// Input shape (subset of QuotaStateFile, all optional-ish)
// -----------------------------------------------------------------------------

export interface AgentBucket {
  model_id?: string;
  provider?: string;
  account?: string;
  display_name?: string;
  window_label?: string;
  tier_type?: TierType;
  capacity?: {
    used_pct?: number;
    reset_in_seconds?: number;
    limit_window_hours?: number;
    resets_at?: string;
    balance_usd?: number;
    spend_usd?: number;
    spend_period_label?: string;
    limit_label?: string;
  };
  waste_risk?: WasteRiskLevel;
  waste_score?: number;
  routing_priority?: number;
  last_updated?: string;
  notes?: string;
  unavailable?: boolean;
  unavailable_reason?: string;
}

export interface AgentTokenTally {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  total?: number;
  requests?: number;
}

export interface AgentModelUsage {
  model: string;
  display_name?: string;
  windows?: { h1?: AgentTokenTally; h5?: AgentTokenTally; h24?: AgentTokenTally };
  last_seen?: string;
  in_catalog?: boolean;
}

export interface AgentProviderModels {
  provider: string;
  account?: string;
  catalog?: string[];
  catalog_labels?: Record<string, string>;
  usage?: AgentModelUsage[];
}

export interface AgentState {
  schema_version?: number;
  generated_at?: string;
  source?: 'real' | 'mock';
  buckets?: AgentBucket[];
  provider_models?: AgentProviderModels[];
}

// -----------------------------------------------------------------------------
// Output shape
// -----------------------------------------------------------------------------

export type WindowKind = 'five_hour' | 'weekly' | 'metered' | 'other';

export interface NormalizedWindow {
  id: string;
  label: string;
  kind: WindowKind;
  tier_type?: TierType;
  used_pct: number | null;
  remaining_pct: number | null;
  limit_window_hours: number | null;
  limit_label: string | null;
  resets_at: string | null;
  reset_in_seconds: number | null;
  reset_in: string;
  dollars_left: number | null;
  dollars_spent: number | null;
  spend_period: string | null;
  risk: WasteRiskLevel;
  routing_priority: number;
  available: boolean;
  unavailable_reason: string | null;
  notes: string | null;
  updated_at: string | null;
}

export interface NormalizedModel {
  model: string;
  display_name: string | null;
  last_seen: string | null;
  in_catalog: boolean | null;
  tokens: {
    h1: { total: number; requests: number } | null;
    h5: { total: number; requests: number } | null;
    h24: { total: number; requests: number } | null;
  };
}

export interface NormalizedProvider {
  provider: string;
  harness?: string;
  account?: string;
  company: string;
  display_name: string;
  status: 'available' | 'metered' | 'unavailable';
  dollars_left: number | null;
  dollars_spent: number | null;
  spend_period: string | null;
  five_hour: NormalizedWindow | null;
  weekly: NormalizedWindow | null;
  windows: NormalizedWindow[];
  unavailable_reason: string | null;
  risk: WasteRiskLevel;
  models: NormalizedModel[];
  catalog?: string[];
  catalog_size: number;
}

export interface RecommendedNext {
  provider: string;
  harness?: string;
  account?: string;
  display_name: string;
  window: string;
  used_pct: number | null;
  remaining_pct: number | null;
  resets_at: string | null;
  reset_in: string;
  risk: WasteRiskLevel;
}

export interface PayloadMeta {
  generated_at: string | null;
  age_seconds: number | null;
  age: string;
  stale: boolean;
  /** 'api' | 'file' — filled in by the caller once the source is known. */
  source?: string;
  refreshed?: boolean;
}

export interface QueryPayload {
  ok: true;
  query: string | null;
  matched_by: 'model' | 'account' | 'provider' | null;
  data: PayloadMeta;
  providers: Array<NormalizedProvider & { matched_models?: string[] }>;
  recommended_next: RecommendedNext | null;
  warnings: string[];
}

export interface ListPayload {
  ok: true;
  data: PayloadMeta;
  providers: Array<Omit<NormalizedProvider, 'models'> & {
    models: Array<{ model: string; h24_total: number; h24_requests: number }>;
  }>;
  recommended_next: RecommendedNext | null;
  warnings: string[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function round(n: number | undefined | null, digits = 1): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return 'now';
  const s = Math.round(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Which of the two headline windows is this bucket? */
function windowKind(bucket: AgentBucket): WindowKind {
  const label = `${bucket.window_label ?? ''} ${bucket.display_name ?? ''}`.toLowerCase();
  const hours = bucket.capacity?.limit_window_hours;
  if (
    hours === 5 ||
    /(^|\D)5\s*-?\s*(h|hour)/.test(label) ||
    /-5h$/.test(bucket.model_id ?? '')
  ) {
    return 'five_hour';
  }
  if (hours === 168 || /weekly|7\s*-?\s*(d|day)/.test(label)) return 'weekly';
  if (bucket.tier_type === 'metered') return 'metered';
  return 'other';
}

function normalizeWindow(bucket: AgentBucket): NormalizedWindow {
  const cap = bucket.capacity ?? {};
  const unavailable = bucket.unavailable === true;
  const used = unavailable ? null : round(cap.used_pct, 1);
  return {
    id: bucket.model_id ?? '',
    label: bucket.window_label ?? bucket.display_name ?? bucket.model_id ?? '',
    kind: windowKind(bucket),
    tier_type: bucket.tier_type,
    used_pct: used,
    remaining_pct: used == null ? null : round(100 - used, 1),
    limit_window_hours: cap.limit_window_hours ?? null,
    limit_label: cap.limit_label ?? null,
    resets_at: cap.resets_at ?? null,
    reset_in_seconds: cap.reset_in_seconds ?? null,
    reset_in: formatDuration(cap.reset_in_seconds),
    dollars_left: cap.balance_usd == null ? null : round(cap.balance_usd, 2),
    dollars_spent: cap.spend_usd == null ? null : round(cap.spend_usd, 2),
    spend_period: cap.spend_period_label ?? null,
    risk: bucket.waste_risk ?? 'NONE',
    routing_priority: bucket.routing_priority ?? 999,
    available: !unavailable,
    unavailable_reason: bucket.unavailable_reason ?? null,
    notes: bucket.notes ?? null,
    updated_at: bucket.last_updated ?? null,
  };
}

function compactTally(
  tally: AgentTokenTally | undefined,
): { total: number; requests: number } | null {
  if (!tally) return null;
  return { total: tally.total ?? 0, requests: tally.requests ?? 0 };
}

function normalizeModels(models: AgentProviderModels | undefined): NormalizedModel[] {
  return (models?.usage ?? []).map((m) => ({
    model: m.model,
    display_name: m.display_name ?? null,
    last_seen: m.last_seen ?? null,
    in_catalog: m.in_catalog ?? null,
    tokens: {
      h1: compactTally(m.windows?.h1),
      h5: compactTally(m.windows?.h5),
      h24: compactTally(m.windows?.h24),
    },
  }));
}

/** One normalized provider entry (per provider, or per account for Gemini). */
function normalizeOne(
  meta: ProviderMeta,
  own: AgentBucket[],
  models: AgentProviderModels | undefined,
  account: string | null,
): NormalizedProvider {
  const windows = own.map(normalizeWindow);
  const fiveHour = windows.find((w) => w.kind === 'five_hour') ?? null;
  const weekly = windows.find((w) => w.kind === 'weekly') ?? null;
  const metered = windows.filter((w) => w.kind === 'metered');

  const dollarsLeft = metered.map((w) => w.dollars_left).find((v) => v != null) ?? null;
  const dollarsSpent = metered.map((w) => w.dollars_spent).find((v) => v != null) ?? null;
  const spendPeriod = metered.map((w) => w.spend_period).find(Boolean) ?? null;

  const available = own.some((b) => b.unavailable !== true);
  const planWindows = windows.filter((w) => w.kind === 'five_hour' || w.kind === 'weekly');

  return {
    provider: meta.id,
    ...(meta.harness ? { harness: meta.harness } : {}),
    ...(account ? { account } : {}),
    company: meta.company,
    display_name: account ? `${meta.label} — ${account}` : meta.label,
    status: !available
      ? 'unavailable'
      : dollarsLeft != null || dollarsSpent != null
        ? 'metered'
        : 'available',
    // Headline numbers an agent asks for:
    dollars_left: dollarsLeft,
    dollars_spent: dollarsSpent,
    spend_period: spendPeriod,
    five_hour: fiveHour,
    weekly,
    // Extra windows only (headline 5h/weekly already above; metered lives here):
    windows: windows.filter((w) => w !== fiveHour && w !== weekly),
    unavailable_reason: own.find((b) => b.unavailable_reason)?.unavailable_reason ?? null,
    // Expiring-capacity hint from the dashboard calculator.
    risk: planWindows.length
      ? planWindows.reduce(
          (worst, w) => (w.routing_priority < worst.routing_priority ? w : worst),
          planWindows[0],
        ).risk
      : 'NONE',
    models: normalizeModels(models),
    // Agy has no local token logs yet; expose its advertised model list so the
    // caller knows what it can route through the harness.
    ...(meta.harness && meta.catalog ? { catalog: meta.catalog } : {}),
    catalog_size: models?.catalog?.length ?? meta.catalog?.length ?? 0,
  };
}

/**
 * Build the compact view for every provider present in the state. Providers
 * with several accounts (Gemini via the Agy harness) become one entry per
 * account, each carrying an `account` field.
 */
export function normalizeProviders(state: AgentState): NormalizedProvider[] {
  const buckets = Array.isArray(state?.buckets) ? state.buckets : [];
  const providerModels = Array.isArray(state?.provider_models) ? state.provider_models : [];
  const out: NormalizedProvider[] = [];

  for (const meta of PROVIDERS) {
    const ownAll = buckets.filter((b) => b.provider === meta.id);
    const models = providerModels.find((p) => p.provider === meta.id);
    const accounts = [...new Set(ownAll.map((b) => b.account ?? null))];

    if (accounts.length === 0) {
      if (models) out.push(normalizeOne(meta, [], models, null));
      continue;
    }

    for (const account of accounts) {
      const own = ownAll.filter((b) => (b.account ?? null) === account);
      out.push(normalizeOne(meta, own, models, account));
    }
  }

  return out;
}

function modelStrings(provider: NormalizedProvider): string[] {
  const out: string[] = [];
  for (const m of provider.models) {
    out.push(m.model);
    if (m.display_name) out.push(m.display_name);
  }
  return out;
}

/** Match "you", "you@example.com", etc. against a provider account. */
function accountMatchesQuery(account: string | undefined, q: string): boolean {
  if (!account || q.length < 4) return false;
  const email = account.toLowerCase();
  const local = email.split('@')[0];
  return email === q || local === q || email.includes(q) || local.includes(q);
}

/** Match a provider by any of its aliases. */
export function matchByProvider(query: string): string[] {
  const q = query.toLowerCase().trim();
  return PROVIDERS.filter((p) => p.aliases.some((a) => aliasMatches(q, a))).map((p) => p.id);
}

function matchingModelNames(
  provider: NormalizedProvider,
  query: string,
  state: AgentState,
): string[] {
  const q = query.toLowerCase().trim();
  const names = new Set(modelStrings(provider).filter((m) => m.toLowerCase().includes(q)));

  // Static catalog for harnesses that do not write provider_models (Agy).
  const meta = PROVIDERS.find((p) => p.id === provider.provider);
  for (const cat of meta?.catalog ?? []) {
    if (cat.toLowerCase().includes(q)) names.add(cat);
  }

  const pm = (state.provider_models ?? []).find((p) => p.provider === provider.provider);
  for (const cat of pm?.catalog ?? []) {
    if (cat.toLowerCase().includes(q)) names.add(cat);
  }
  return [...names];
}

/** Exact model id/display-name match (static catalogs + observed usage). */
function exactModelMatches(
  providers: NormalizedProvider[],
  state: AgentState,
  query: string,
): Map<string, string[]> {
  const q = query.toLowerCase().trim();
  const out = new Map<string, string[]>();

  for (const p of providers) {
    const meta = PROVIDERS.find((m) => m.id === p.provider);
    const names = new Set<string>();
    for (const m of meta?.catalog ?? []) names.add(m);

    const pm = (state.provider_models ?? []).find((pm) => pm.provider === p.provider);
    for (const m of pm?.catalog ?? []) names.add(m);

    for (const m of p.models) {
      names.add(m.model);
      if (m.display_name) names.add(m.display_name);
    }

    for (const name of names) {
      if (name.toLowerCase() === q) {
        out.set(p.provider, [name]);
        break;
      }
    }
  }

  return out;
}

/** Query by company name, model name, or account email/local-part. */
export function queryState(
  state: AgentState,
  query: string,
  opts: { includeModels?: boolean } = {},
): QueryPayload {
  const includeModels = opts.includeModels !== false;
  const all = normalizeProviders(state);
  const q = String(query ?? '').trim();
  const age = stateAgeSeconds(state);

  let matchedBy: QueryPayload['matched_by'] = null;
  let matches: NormalizedProvider[] = [];
  const modelMatches = new Map<string, string[]>();

  // Exact model id wins, so "gemini-3.8-flash-high" resolves as a model even
  // though the provider alias "gemini" is also a substring.
  if (q) {
    const exact = exactModelMatches(all, state, q);
    if (exact.size > 0) {
      matchedBy = 'model';
      matches = all.filter((p) => exact.has(p.provider));
      for (const [providerId, names] of exact) modelMatches.set(providerId, names);
    }
  }

  if (matches.length === 0 && q) {
    const accountMatches = all.filter((p) => accountMatchesQuery(p.account, q));
    if (accountMatches.length > 0) {
      matchedBy = 'account';
      matches = accountMatches;
    }
  }

  if (matches.length === 0 && q) {
    const providerIds = matchByProvider(q);
    if (providerIds.length > 0) {
      matchedBy = 'provider';
      matches = all.filter((p) => providerIds.includes(p.provider));
    }
  }

  // Model-name route: usage first (models with recent traffic), then catalogs.
  if (matches.length === 0 && q) {
    for (const p of all) {
      const names = matchingModelNames(p, q, state);
      if (names.length > 0) modelMatches.set(p.provider, names);
    }
    if (modelMatches.size > 0) {
      matchedBy = 'model';
      matches = all.filter((p) => modelMatches.has(p.provider));
    }
  }

  const providers = matches.map((p) => {
    const matchedNames = modelMatches.get(p.provider);
    return {
      ...p,
      models: includeModels ? p.models : [],
      ...(matchedNames ? { matched_models: matchedNames } : {}),
    };
  });

  const warnings: string[] = [];
  if (!q) {
    warnings.push('no query supplied — use a company ("claude") or model ("kimi-for-coding") name');
  }
  if (q && providers.length === 0) {
    const suggestions: string[] = [];
    for (const p of all) suggestions.push(p.display_name);
    for (const p of all) {
      for (const m of p.models.slice(0, 2)) suggestions.push(m.model);
    }
    warnings.push(`no provider or model matched "${q}"`);
    warnings.push(`try one of: ${suggestions.join(', ')}`);
  }
  if (age > 900) {
    warnings.push(
      `snapshot is ${formatDuration(age)} old — dashboard scraper may not be running; pass refresh:true for a fresh scrape`,
    );
  }

  return {
    ok: true,
    query: q || null,
    matched_by: matchedBy,
    data: {
      generated_at: state?.generated_at ?? null,
      age_seconds: Number.isFinite(age) ? age : null,
      age: Number.isFinite(age) ? formatDuration(age) : 'unknown',
      stale: age > 300,
      source: state?.source ?? 'real',
    },
    providers,
    recommended_next: recommendedNext(state),
    warnings,
  };
}

/** Lowest routing_priority plan window — the capacity that expires soonest. */
export function recommendedNext(state: AgentState): RecommendedNext | null {
  const buckets = Array.isArray(state?.buckets) ? state.buckets : [];
  const candidates = buckets
    .filter(
      (b) =>
        b.unavailable !== true &&
        b.tier_type !== 'metered' &&
        (b.routing_priority ?? 999) < 99 &&
        (b.capacity?.used_pct ?? 0) < 100,
    )
    .sort(
      (a, b) =>
        (a.routing_priority ?? 999) - (b.routing_priority ?? 999) ||
        (b.waste_score ?? 0) - (a.waste_score ?? 0),
    );

  const top = candidates[0];
  if (!top) return null;
  const meta = providerMeta(top.provider ?? '');
  const account = top.account ?? null;
  return {
    provider: top.provider ?? meta.id,
    ...(meta.harness ? { harness: meta.harness } : {}),
    ...(account ? { account } : {}),
    display_name: account ? `${meta.label} — ${account}` : meta.label,
    window: top.window_label ?? top.display_name ?? '',
    used_pct: round(top.capacity?.used_pct, 1),
    remaining_pct: round(100 - (top.capacity?.used_pct ?? 0), 1),
    resets_at: top.capacity?.resets_at ?? null,
    reset_in: formatDuration(top.capacity?.reset_in_seconds),
    risk: top.waste_risk ?? 'NONE',
  };
}

/** Full snapshot of every provider — the "what have I got?" view. */
export function listState(state: AgentState): ListPayload {
  const providers = normalizeProviders(state).map((p) => ({
    ...p,
    models: p.models.map((m) => ({
      model: m.model,
      h24_total: m.tokens?.h24?.total ?? 0,
      h24_requests: m.tokens?.h24?.requests ?? 0,
    })),
  }));
  const age = stateAgeSeconds(state);
  return {
    ok: true,
    data: {
      generated_at: state?.generated_at ?? null,
      age_seconds: Number.isFinite(age) ? age : null,
      age: Number.isFinite(age) ? formatDuration(age) : 'unknown',
      stale: age > 300,
    },
    providers,
    recommended_next: recommendedNext(state),
    warnings: age > 900 ? [`snapshot is ${formatDuration(age)} old`] : [],
  };
}
