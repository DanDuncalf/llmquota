// =============================================================================
// Mock state generator — mirrors the REAL bucket set with drifting values
// =============================================================================
// Used only when running with --mock / USE_REAL_SCRAPERS=0. It produces the
// same provider/window shape as real mode (Claude 5h+weekly, ChatGPT 5h+weekly,
// Kimi 5h+weekly, MiniMax 5h+weekly, DeepSeek balance, DeepInfra monthly spend)
// so the UI can be exercised without credentials or network access.
//
// On every tick it:
//   1. Reads the previous state.json to preserve identities.
//   2. Drifts used_pct upward; decrements timers; resets windows at expiry.
//   3. Moves metered balances down and metered spend up.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichBucket } from './calculator.js';
import type {
  ModelUsage,
  NormalizedQuotaBucket,
  Provider,
  ProviderModels,
  QuotaStateFile,
  TierType,
  TokenTally,
} from '../types/quota.js';
import { PROVIDER_ORDER } from '../types/quota.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../../data/state.json');

const SECONDS_PER_HOUR = 3600;

interface BucketTemplate {
  model_id: string;
  provider: Provider;
  account?: string;
  display_name: string;
  window_label: string;
  tier_type: TierType;
  limit_window_hours: number;
  limit_label: string;
  reset_floor: number;
  reset_ceiling: number;
  drift_per_tick: number;
  /** For metered buckets: does the number go down (prepaid) or up (spend)? */
  metered_mode?: 'balance' | 'spend' | 'both';
  metered_start?: number;
}

const TEMPLATES: BucketTemplate[] = [
  // --- Claude (Pro) ---
  { model_id: 'claude-5h', provider: 'anthropic', display_name: 'Claude · 5-hour session', window_label: '5h session', tier_type: 'rolling_window', limit_window_hours: 5, limit_label: 'Pro plan', reset_floor: 5, reset_ceiling: 25, drift_per_tick: 0.8 },
  { model_id: 'claude-weekly', provider: 'anthropic', display_name: 'Claude · Weekly (all models)', window_label: 'Weekly', tier_type: 'periodic_fixed', limit_window_hours: 168, limit_label: 'Pro plan', reset_floor: 10, reset_ceiling: 30, drift_per_tick: 0.06 },
  // --- ChatGPT (Plus) ---
  { model_id: 'chatgpt-5h', provider: 'openai', display_name: 'ChatGPT Plus · 5-hour session', window_label: '5h session', tier_type: 'rolling_window', limit_window_hours: 5, limit_label: 'Plus plan', reset_floor: 1, reset_ceiling: 20, drift_per_tick: 0.9 },
  { model_id: 'chatgpt-weekly', provider: 'openai', display_name: 'ChatGPT Plus · Weekly', window_label: 'Weekly', tier_type: 'periodic_fixed', limit_window_hours: 168, limit_label: 'Plus plan', reset_floor: 5, reset_ceiling: 25, drift_per_tick: 0.07 },
  // --- Gemini (two Google accounts) ---
  { model_id: 'gemini-a-pro', provider: 'gemini', account: 'you@example.com', display_name: 'Gemini · Gemini 2.5 Pro', window_label: 'Gemini 2.5 Pro', tier_type: 'rolling_window', limit_window_hours: 24, limit_label: 'Gemini Code Assist · mock', reset_floor: 20, reset_ceiling: 55, drift_per_tick: 0.4 },
  { model_id: 'gemini-a-flash', provider: 'gemini', account: 'you@example.com', display_name: 'Gemini · Gemini 2.5 Flash', window_label: 'Gemini 2.5 Flash', tier_type: 'rolling_window', limit_window_hours: 24, limit_label: 'Gemini Code Assist · mock', reset_floor: 10, reset_ceiling: 40, drift_per_tick: 0.3 },
  { model_id: 'gemini-b-pro', provider: 'gemini', account: 'second@example.com', display_name: 'Gemini · Gemini 2.5 Pro', window_label: 'Gemini 2.5 Pro', tier_type: 'rolling_window', limit_window_hours: 24, limit_label: 'Gemini Code Assist · mock', reset_floor: 25, reset_ceiling: 60, drift_per_tick: 0.35 },
  { model_id: 'gemini-b-flash', provider: 'gemini', account: 'second@example.com', display_name: 'Gemini · Gemini 2.5 Flash', window_label: 'Gemini 2.5 Flash', tier_type: 'rolling_window', limit_window_hours: 24, limit_label: 'Gemini Code Assist · mock', reset_floor: 15, reset_ceiling: 45, drift_per_tick: 0.25 },
  // --- Moonshot (Code Plan) ---
  { model_id: 'kimi-5h', provider: 'moonshot', display_name: 'Moonshot · 5-hour session', window_label: '5h session', tier_type: 'rolling_window', limit_window_hours: 5, limit_label: 'Code Plan', reset_floor: 5, reset_ceiling: 30, drift_per_tick: 0.7 },
  { model_id: 'kimi-weekly', provider: 'moonshot', display_name: 'Moonshot · Weekly', window_label: 'Weekly', tier_type: 'periodic_fixed', limit_window_hours: 168, limit_label: 'Code Plan', reset_floor: 8, reset_ceiling: 25, drift_per_tick: 0.05 },
  { model_id: 'kimi-backup', provider: 'moonshot', display_name: 'Moonshot · Booster wallet (backup)', window_label: 'backup balance', tier_type: 'metered', limit_window_hours: 0, limit_label: '$10.00 reserved · $5.13 used 2026-10', reset_floor: 0, reset_ceiling: 0, drift_per_tick: 0, metered_mode: 'balance', metered_start: 4.87 },
  // --- MiniMax (plan) ---
  { model_id: 'minimax-5h', provider: 'minimax', display_name: 'MiniMax · 5-hour session', window_label: '5h session', tier_type: 'rolling_window', limit_window_hours: 5, limit_label: 'coding plan', reset_floor: 5, reset_ceiling: 30, drift_per_tick: 0.6 },
  { model_id: 'minimax-weekly', provider: 'minimax', display_name: 'MiniMax · Weekly', window_label: 'Weekly', tier_type: 'periodic_fixed', limit_window_hours: 168, limit_label: 'coding plan', reset_floor: 10, reset_ceiling: 30, drift_per_tick: 0.04 },
  // --- Qwen (Alibaba ModelStudio Token Plan) ---
  { model_id: 'qwen-5h', provider: 'qwen', display_name: 'Qwen · ModelStudio Token Plan', window_label: 'token plan', tier_type: 'rolling_window', limit_window_hours: 5, limit_label: 'ModelStudio Token Plan', reset_floor: 4, reset_ceiling: 28, drift_per_tick: 0.55 },
  // --- Metered ---
  { model_id: 'deepseek-balance', provider: 'deepseek', display_name: 'DeepSeek · Metered balance', window_label: 'metered balance', tier_type: 'metered', limit_window_hours: 0, limit_label: 'Pay-as-you-go · prepaid', reset_floor: 0, reset_ceiling: 0, drift_per_tick: 0, metered_mode: 'balance', metered_start: 20.8 },
  { model_id: 'deepinfra-spend', provider: 'deepinfra', display_name: 'DeepInfra · Metered (month to date)', window_label: 'balance & spend', tier_type: 'metered', limit_window_hours: 0, limit_label: 'Pay-as-you-go · month to date', reset_floor: 0, reset_ceiling: 0, drift_per_tick: 0, metered_mode: 'both', metered_start: 15.5 },
];

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------
function readState(): QuotaStateFile | null {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as QuotaStateFile;
  } catch {
    return null;
  }
}

function writeState(state: QuotaStateFile): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

// -----------------------------------------------------------------------------
// Drift math
// -----------------------------------------------------------------------------
function secondsUntilSundayUtc(now: Date = new Date()): number {
  const next = new Date(now);
  const daysUntilSunday = (7 - next.getUTCDay()) % 7;
  next.setUTCDate(next.getUTCDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  next.setUTCHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function nextWindowSeconds(t: BucketTemplate): number {
  if (t.tier_type === 'periodic_fixed') return secondsUntilSundayUtc();
  return t.limit_window_hours * SECONDS_PER_HOUR;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

interface BucketState {
  used_pct: number;
  reset_in_seconds: number;
  balance_usd?: number;
  spend_usd?: number;
}

function tickBucket(t: BucketTemplate, prev: BucketState | undefined): BucketState {
  if (!prev) {
    return {
      used_pct:
        t.reset_floor + Math.random() * (t.reset_ceiling - t.reset_floor || 0),
      reset_in_seconds: nextWindowSeconds(t),
      balance_usd: t.metered_mode === 'balance' || t.metered_mode === 'both' ? (t.metered_start ?? 20) : undefined,
      spend_usd: t.metered_mode === 'spend' ? (t.metered_start ?? 0) : t.metered_mode === 'both' ? 0.05 : undefined,
    };
  }

  if (t.tier_type === 'metered') {
    if (t.metered_mode === 'both') {
      const cost = 0.0008 + Math.random() * 0.0015;
      return {
        used_pct: 0,
        reset_in_seconds: 0,
        balance_usd: Math.max(0, (prev.balance_usd ?? 15.5) - cost),
        spend_usd: Math.round(((prev.spend_usd ?? 0.05) + cost) * 1000) / 1000,
      };
    }
    if (t.metered_mode === 'spend') {
      return {
        used_pct: 0,
        reset_in_seconds: 0,
        spend_usd: Math.round(((prev.spend_usd ?? 0) + 0.004 + Math.random() * 0.01) * 1000) / 1000,
      };
    }
    const cost = 0.0008 + Math.random() * 0.0015;
    return { used_pct: 0, reset_in_seconds: 0, balance_usd: Math.max(0, (prev.balance_usd ?? 0) - cost) };
  }

  let used = clampPct(prev.used_pct + t.drift_per_tick * (0.7 + Math.random() * 0.6));
  let reset = prev.reset_in_seconds - 60;
  if (reset <= 0) {
    used = t.reset_floor + Math.random() * (t.reset_ceiling - t.reset_floor);
    reset = nextWindowSeconds(t);
  }
  if (used >= 99.5) used = 99.9;
  return { used_pct: used, reset_in_seconds: Math.max(0, reset) };
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------
export function generateMockState(): QuotaStateFile {
  const prev = readState();
  const prevById = new Map<string, NormalizedQuotaBucket>();
  for (const b of prev?.buckets ?? []) prevById.set(b.model_id, b);

  const now = new Date();
  const nowIso = now.toISOString();

  const buckets: NormalizedQuotaBucket[] = TEMPLATES.map((t) => {
    const pb = prevById.get(t.model_id);
    const prevState: BucketState | undefined = pb
      ? {
          used_pct: pb.capacity.used_pct,
          reset_in_seconds: pb.capacity.reset_in_seconds,
          balance_usd: pb.capacity.balance_usd,
          spend_usd: pb.capacity.spend_usd,
        }
      : undefined;

    const next = tickBucket(t, prevState);
    const resetInSeconds = Math.round(next.reset_in_seconds);

    return enrichBucket({
      model_id: t.model_id,
      provider: t.provider,
      account: t.account,
      display_name: t.display_name,
      window_label: t.window_label,
      tier_type: t.tier_type,
      capacity: {
        used_pct: Math.round(next.used_pct * 10) / 10,
        reset_in_seconds: resetInSeconds,
        limit_window_hours:
          t.tier_type === 'periodic_fixed'
            ? Math.round((resetInSeconds / SECONDS_PER_HOUR) * 10) / 10
            : t.limit_window_hours,
        resets_at: new Date(now.getTime() + resetInSeconds * 1000).toISOString(),
        balance_usd:
          next.balance_usd !== undefined ? Math.round(next.balance_usd * 10000) / 10000 : undefined,
        spend_usd:
          next.spend_usd !== undefined ? Math.round(next.spend_usd * 10000) / 10000 : undefined,
        spend_period_label: t.metered_mode === 'spend' ? `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}` : undefined,
        limit_label: t.limit_label,
      },
      last_updated: nowIso,
      notes: 'Mock generator',
      reset_credits:
        t.model_id === 'chatgpt-5h'
          ? [3, 10, 18].map((days, i) => ({
              id: `mock-reset-${i}`,
              title: 'Full reset (Weekly + 5 hr)',
              description: 'Mock banked rate-limit reset.',
              status: 'available',
              granted_at: new Date(now.getTime() - (30 - days) * 86_400_000).toISOString(),
              expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
            }))
          : undefined,
    });
  });

  const state: QuotaStateFile = {
    schema_version: 1,
    generated_at: nowIso,
    source: 'mock',
    buckets,
    provider_models: generateMockProviderModels(),
  };
  writeState(state);
  return state;
}

// -----------------------------------------------------------------------------
// Mock provider catalogs + usage (so the UI is exercised without real logs)
// -----------------------------------------------------------------------------
function tally(base: number): TokenTally {
  const jitter = (r: number) => Math.round(base * r * (0.6 + Math.random() * 0.8));
  const input = jitter(0.35);
  const output = jitter(0.05);
  const cacheRead = jitter(0.55);
  const cacheWrite = jitter(0.05);
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    requests: 3 + Math.floor(Math.random() * 40),
  };
}

function mockUsage(model: string, scale: number, inCatalog: boolean): ModelUsage {
  return {
    model,
    windows: { h1: tally(scale), h5: tally(scale * 3), h24: tally(scale * 9) },
    last_seen: new Date().toISOString(),
    in_catalog: inCatalog,
  };
}

interface MockModelSpec {
  provider: Provider;
  catalog: string[];
  usage: Array<[string, number]>;
  catalog_source: ProviderModels['catalog_source'];
  usage_source: string;
  monthly?: ProviderModels['monthly'];
}

const MOCK_MODELS: MockModelSpec[] = [
  {
    provider: 'anthropic',
    catalog: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-6', 'claude-fable-5'],
    usage: [['claude-opus-5', 480_000], ['claude-sonnet-5', 260_000]],
    catalog_source: 'observed',
    usage_source: 'local CLI logs',
  },
  {
    provider: 'openai',
    catalog: ['gpt-6-astra', 'gpt-5.3-codex', 'gpt-5.6-luna'],
    usage: [['gpt-6-astra', 180_000]],
    catalog_source: 'observed',
    usage_source: 'local CLI logs',
  },
  {
    provider: 'moonshot',
    catalog: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    usage: [['k3', 320_000], ['kimi-for-coding', 90_000]],
    catalog_source: 'provider_api',
    usage_source: 'local CLI logs',
  },
  {
    provider: 'minimax',
    catalog: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    usage: [['MiniMax-M2.7', 40_000]],
    catalog_source: 'provider_api',
    usage_source: 'local CLI logs',
  },
  {
    provider: 'deepinfra',
    catalog: [
      'moonshotai/Kimi-K3',
      'deepseek-ai/DeepSeek-V4',
      'meta-llama/Llama-3.3-70B-Instruct',
    ],
    usage: [],
    catalog_source: 'provider_api',
    usage_source: 'DeepInfra billing API (monthly)',
    monthly: {
      period: 'MOCK',
      total_tokens: 24_000_000,
      models: [
        { model: 'moonshotai/Kimi-K3', tokens: 18_000_000, cost_usd: 4.24 },
        { model: 'deepseek-ai/DeepSeek-V4', tokens: 6_000_000, cost_usd: 1.11 },
      ],
    },
  },
  {
    provider: 'deepseek',
    catalog: ['deepseek-flash', 'deepseek-v4-pro'],
    usage: [['deepseek-v4-pro', 30_000]],
    catalog_source: 'provider_api',
    usage_source: 'local CLI logs',
  },
  {
    provider: 'qwen',
    catalog: [
      'qwen3.6-plus',
      'qwen3.7-max',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'kimi-k2.5',
      'glm-5.1',
      'MiniMax-M2.5',
    ],
    usage: [['qwen3.6-plus', 700_000], ['MiniMax-M2.7', 120_000], ['deepseek-v4-pro', 60_000]],
    catalog_source: 'local_config',
    usage_source: 'local CLI logs',
  },
];

export function generateMockProviderModels(): ProviderModels[] {
  const byProvider = new Map(MOCK_MODELS.map((m) => [m.provider, m]));
  return PROVIDER_ORDER.map((provider) => {
    const spec = byProvider.get(provider);
    const catalog = spec?.catalog ?? [];
    const usage = (spec?.usage ?? []).map(([model, scale]) =>
      mockUsage(model, scale, catalog.includes(model)),
    );
    return {
      provider,
      catalog,
      catalog_source: spec?.catalog_source ?? 'unavailable',
      usage,
      usage_source: spec?.usage_source ?? 'none',
      monthly: spec?.monthly,
      note: spec ? 'Mock generator' : 'no catalog and no local usage in the last 24h',
    } satisfies ProviderModels;
  });
}

/** Convenience: write a fresh random state (no drift from previous). */
export function resetMockState(): QuotaStateFile {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  return generateMockState();
}

export const MOCK_STATE_PATH = STATE_PATH;
