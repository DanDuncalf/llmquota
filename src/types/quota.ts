// =============================================================================
// Core Type Definitions — Quota Dashboard
// =============================================================================
// Shared between the scraper daemon, the API server, and the React dashboard.
// Keep this file free of runtime imports so it can be consumed from anywhere.
//
// Two related views of the world:
//   * Buckets  — one per quota WINDOW (5h session, weekly cap, metered balance).
//                The UI groups these by provider → one card per subscription.
//   * ProviderModels — per provider: the full model catalog + per-model token
//                usage over rolling 1h / 5h / 24h windows (from local CLI logs
//                and, where available, provider usage APIs).
// =============================================================================

export type Provider =
  | 'anthropic'   // Claude Pro / Max (claude.ai plan windows)
  | 'openai'      // ChatGPT Plus / Pro (Codex rate-limit windows)
  | 'gemini'      // Google Gemini CLI / Code Assist (one card per account)
  | 'moonshot'    // Kimi Code Plan (5h + weekly windows)
  | 'minimax'     // MiniMax coding/token plan
  | 'deepseek'    // DeepSeek metered (pay-as-you-go balance)
  | 'deepinfra'   // DeepInfra metered (pay-as-you-go spend)
  | 'qwen';       // Qwen (Qwen Code CLI)

export type TierType =
  | 'rolling_window'   // 3h / 5h / etc — refills on a rolling basis
  | 'periodic_fixed'   // Weekly / monthly — refills at a fixed calendar boundary
  | 'metered';         // Pay-as-you-go balance / spend

export type WasteRiskLevel =
  | 'CRITICAL'  // ⚡ Lots of expiring capacity — use immediately
  | 'HIGH'      // Significant expiring capacity — prefer over MODERATE
  | 'MODERATE'  // Some capacity available, normal use
  | 'LOW'       // Mostly full / low priority
  | 'NONE';     // Exhausted, metered, or unavailable

/**
 * A banked usage-limit reset credit (ChatGPT / Codex). Each credit lets you
 * reset the rate-limit windows once and expires if unused.
 */
export interface UsageResetCredit {
  id: string;
  /** Short product label, e.g. "Full reset (Weekly + 5 hr)". */
  title?: string;
  /** Longer explanation, shown as a tooltip. */
  description?: string;
  /** Provider state, e.g. "available" / "redeemed". Only available ones ship. */
  status?: string;
  reset_type?: string;
  /** ISO timestamp when the credit was granted. */
  granted_at?: string;
  /** ISO timestamp when the credit expires unused. */
  expires_at?: string;
}

/**
 * NormalizedQuotaBucket is the single canonical shape that flows from the
 * scraper → state.json → API → React UI. Every provider scraper must produce
 * one of these per tracked quota window.
 */
export interface NormalizedQuotaBucket {
  /** Stable identifier, e.g. "claude-5h" or "kimi-weekly". */
  model_id: string;

  /** Provider brand — used to group cards, plus icon / color. */
  provider: Provider;

  /**
   * Optional account identity for providers that can hold several logins
   * (Gemini). Cards are grouped by provider + account, so two accounts of the
   * same provider render as two separate cards.
   */
  account?: string;

  /** Long display label, e.g. "Claude · 5-hour session". */
  display_name: string;

  /** Short label for the row inside a provider card, e.g. "5h session". */
  window_label?: string;

  /** Tier classification — drives calculator logic. */
  tier_type: TierType;

  capacity: {
    /** 0.0 – 100.0 percentage of the quota window consumed. */
    used_pct: number;
    /** Seconds until the quota resets / refills / refills-window advances. */
    reset_in_seconds: number;
    /** Window size in hours (for rolling_window and periodic_fixed). */
    limit_window_hours?: number;
    /** Absolute reset timestamp (ISO 8601). Useful for debugging / tooltip. */
    resets_at?: string;
    /** USD balance — only populated for prepaid metered tiers (e.g. DeepSeek). */
    balance_usd?: number;
    /** USD spent in the current period — for postpaid metered tiers (DeepInfra). */
    spend_usd?: number;
    /** Label for the spend period, e.g. "2026.10". */
    spend_period_label?: string;
    /** Soft / hard limit label, e.g. "160 msgs / 3h". */
    limit_label?: string;
  };

  /** Computed by calculator.ts — see Waste Risk rules. */
  waste_risk: WasteRiskLevel;

  /** Raw waste score, higher = more expiring capacity. Exposed for sorting. */
  waste_score: number;

  /**
   * Routing priority — lower number = use sooner.
   *   1   = CRITICAL (use right now)
   *   5   = HIGH
   *   10  = MODERATE
   *   20  = LOW
   *   99  = NONE (metered — paid fallback)
   *   999 = NONE (exhausted / unavailable — do not route)
   */
  routing_priority: number;

  /** ISO timestamp of last scrape for this bucket. */
  last_updated: string;

  /** Free-form status note shown as a chip / tooltip. */
  notes?: string;

  /**
   * Banked usage-limit reset credits for the account (ChatGPT). Account-level
   * data, so a provider attaches it to one bucket only; consumers dedupe by id.
   */
  reset_credits?: UsageResetCredit[];

  /**
   * True when this window could not be read (missing credential, no active
   * plan, provider error). The UI renders these muted rather than pretending
   * the quota is 0 %.
   */
  unavailable?: boolean;

  /** Human-readable explanation for `unavailable`, e.g. "no active plan". */
  unavailable_reason?: string;
}

// -----------------------------------------------------------------------------
// Token usage (per model, rolling windows)
// -----------------------------------------------------------------------------

/** Token counts for one model over one time window. */
export interface TokenTally {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** input + output + cache_read + cache_write. */
  total: number;
  /** Number of API/turn records contributing. */
  requests: number;
}

/** Per-model usage across the three rolling windows the dashboard shows. */
export interface ModelUsage {
  /** Raw model id as reported by the source, e.g. "claude-opus-4-8". */
  model: string;
  /** Friendlier name when the provider catalog gives one. */
  display_name?: string;
  windows: {
    h1: TokenTally;
    h5: TokenTally;
    h24: TokenTally;
  };
  /** ISO timestamp of the most recent record for this model. */
  last_seen?: string;
  /** True when this model appears in the provider's advertised catalog. */
  in_catalog?: boolean;
}

/** Per-provider model catalog + usage rollup. */
export interface ProviderModels {
  provider: Provider;
  /** Account identity when the provider has multiple logins (Gemini). */
  account?: string;
  /** Every model id the provider offers (may be large, e.g. DeepInfra = 177). */
  catalog: string[];
  /** Human-readable names keyed by catalog id, where the provider supplies them. */
  catalog_labels?: Record<string, string>;
  /** Where the catalog came from. */
  catalog_source: 'provider_api' | 'local_config' | 'observed' | 'mixed' | 'unavailable';
  /** Models with activity inside the widest window (24h), most-used first. */
  usage: ModelUsage[];
  /** Where the usage numbers came from, e.g. local CLI logs. */
  usage_source: string;
  /**
   * Newest local-log file mtime for this provider's CLI (ISO). Lets the UI show
   * "last used 2026-10-04" when there is no traffic inside the 24h window.
   */
  last_activity?: string;
  /**
   * Providers whose billing API only reports monthly aggregates (DeepInfra)
   * — surfaced separately instead of faking a 24h window.
   */
  monthly?: {
    period: string;
    total_tokens: number;
    models: Array<{ model: string; tokens: number; cost_usd: number }>;
  };
  /** Any caveat worth surfacing, e.g. no local usage logs found. */
  note?: string;
}

/**
 * The full state file written by the scraper daemon and read by the API server.
 * Versioned so we can migrate the on-disk format cleanly in the future.
 */
export interface QuotaStateFile {
  schema_version: 1;
  generated_at: string;
  source: 'mock' | 'real';
  buckets: NormalizedQuotaBucket[];
  /** Optional so older/partial states still validate. */
  provider_models?: ProviderModels[];
}

/** A count plus the providers that contributed to it. */
export interface StatusGroup {
  count: number;
  providers: Provider[];
}

/** Optional metadata the dashboard uses to render the header. */
export interface DashboardSummary {
  total_buckets: number;
  total_providers: number;
  /** All providers present in the state, in display order. */
  providers: Provider[];
  critical: StatusGroup;
  high: StatusGroup;
  exhausted: StatusGroup;
  unavailable: StatusGroup;
  metered: StatusGroup;
  metered_fallback: boolean;
  /** The single bucket with the lowest routing_priority (i.e. what to use next). */
  top_recommendation?: NormalizedQuotaBucket;
}

/**
 * Normalized key for comparing model ids across sources.
 * Kimi Code logs say "kimi-code/k3" while the catalog says "k3" — compare on the
 * last path segment so catalog membership works either way.
 */
export function modelKey(model: string): string {
  const lower = model.toLowerCase();
  return lower.split('/').pop() ?? lower;
}

/** Display order + names for provider cards. Shared by UI and text renderer. */
export const PROVIDER_ORDER: Provider[] = [
  'anthropic',
  'openai',
  'gemini',
  'moonshot',
  'minimax',
  'deepinfra',
  'deepseek',
  'qwen',
];

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  gemini: 'Antigravity',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  deepinfra: 'DeepInfra',
  qwen: 'Qwen',
};

/**
 * Where to send someone who clicks a provider — its own console / usage page.
 * Change a value here to point a card somewhere else (used by both the web UI
 * and the text renderer).
 */
export const PROVIDER_URL: Record<Provider, string> = {
  anthropic: 'https://claude.ai/settings/usage',
  openai: 'https://chatgpt.com/',
  gemini: 'https://antigravity.google/',
  moonshot: 'https://www.kimi.ai/settings/subscription?tab=quota',
  minimax: 'https://platform.minimax.io/',
  deepinfra: 'https://deepinfra.com/dash/usage',
  deepseek: 'https://platform.deepseek.com/usage',
  qwen: 'https://modelstudio.console.alibabacloud.com/',
};

/** Short host label for a provider URL, e.g. "deepinfra.com". */
export function providerHost(provider: Provider): string {
  try {
    return new URL(PROVIDER_URL[provider]).host.replace(/^www\./, '');
  } catch {
    return PROVIDER_URL[provider];
  }
}
