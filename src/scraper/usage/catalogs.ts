// =============================================================================
// Provider model catalogs (+ DeepInfra monthly token usage)
// =============================================================================
// Where a provider exposes a model list we fetch it:
//
//   Kimi       GET https://api.kimi.com/coding/v1/models      (KIMI_API_KEY)
//   DeepSeek   GET https://api.deepseek.com/models            (DEEPSEEK_API_KEY)
//   MiniMax    GET https://api.minimax.io/v1/models           (MINIMAX_API_KEY)
//   DeepInfra  GET https://api.deepinfra.com/v1/openai/models  (public)
//   ChatGPT    ~/.codex/models_cache.json     (written by the Codex CLI)
//
// Where an API returns `display_name` (Kimi, ChatGPT) we keep an id → label map
// so the UI can show "K2.8 Preview" instead of "kimi-for-coding".
//
// Claude and Qwen have no key-based public catalog here, so their "catalog" is
// the set of models observed in local logs — flagged as `observed` so the UI
// can be honest about it.
//
// DeepInfra is also the only provider that exposes per-model TOKEN counts via
// an API, but only at MONTH granularity:
//   GET https://api.deepinfra.com/payment/usage/tokens?from=YYYY.MM&to=YYYY.MM
// We surface that separately as `monthly` rather than faking a 24h window.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider } from '../../types/quota.js';
import { httpJson } from '../providers/base.js';

export interface CatalogResult {
  models: string[];
  source: 'provider_api' | 'local_config' | 'observed' | 'unavailable';
  /** Human-readable names keyed by model id, when the provider supplies them. */
  labels?: Record<string, string>;
  error?: string;
}

async function listModels(
  url: string,
  headers: Record<string, string>,
  pick: (row: Record<string, unknown>) => string | undefined,
  pickLabel?: (row: Record<string, unknown>) => string | undefined,
): Promise<CatalogResult> {
  try {
    const data = await httpJson<{ data?: Array<Record<string, unknown>> }>(url, { headers });
    const rows = data.data ?? [];
    const models = rows
      .map(pick)
      .filter((m): m is string => Boolean(m));

    const labels: Record<string, string> = {};
    if (pickLabel) {
      for (const row of rows) {
        const id = pick(row);
        const label = pickLabel(row);
        if (id && label && label !== id) labels[id] = label;
      }
    }

    return {
      models: [...new Set(models)].sort(),
      source: 'provider_api',
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    };
  } catch (err) {
    return { models: [], source: 'unavailable', error: (err as Error).message };
  }
}

/** Catalog lists change slowly — cache them so ticks stay fast. */
const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS ?? 15 * 60 * 1000);
let catalogCache: { at: number; data: Record<Provider, CatalogResult> } | null = null;

/** Fetch every provider catalog we can (15-minute cache). Never throws. */
export async function fetchCatalogs(): Promise<Record<Provider, CatalogResult>> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  const data = await fetchCatalogsUncached();
  catalogCache = { at: Date.now(), data };
  return data;
}

async function fetchCatalogsUncached(): Promise<Record<Provider, CatalogResult>> {
  const byId = (row: Record<string, unknown>) =>
    typeof row.id === 'string' ? row.id : undefined;
  const byDisplayName = (row: Record<string, unknown>) =>
    typeof row.display_name === 'string' ? row.display_name : undefined;

  const [kimi, deepseek, minimax, deepinfra] = await Promise.all([
    process.env.KIMI_API_KEY
      ? listModels(
          'https://api.kimi.com/coding/v1/models',
          { Authorization: `Bearer ${process.env.KIMI_API_KEY}` },
          byId,
          byDisplayName,
        )
      : Promise.resolve<CatalogResult>({ models: [], source: 'unavailable', error: 'no KIMI_API_KEY' }),
    process.env.DEEPSEEK_API_KEY
      ? listModels(
          'https://api.deepseek.com/models',
          { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
          byId,
        )
      : Promise.resolve<CatalogResult>({ models: [], source: 'unavailable', error: 'no DEEPSEEK_API_KEY' }),
    process.env.MINIMAX_API_KEY
      ? listModels(
          'https://api.minimax.io/v1/models',
          { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
          byId,
        )
      : Promise.resolve<CatalogResult>({ models: [], source: 'unavailable', error: 'no MINIMAX_API_KEY' }),
    listModels('https://api.deepinfra.com/v1/openai/models', {}, byId),
  ]);

  return {
    moonshot: kimi,
    deepseek,
    minimax,
    deepinfra,
    // No public catalog without a key — filled from observed usage instead.
    anthropic: { models: [], source: 'observed' },
    openai: readCodexCatalog(),
    gemini: { models: [], source: 'observed' },
    qwen: readQwenPlanCatalog(),
  };
}

/**
 * The Codex CLI caches the model list the ChatGPT backend advertises in
 * ~/.codex/models_cache.json. That is the authoritative catalog for this
 * account — local logs only reveal the models that were actually used.
 * Hidden entries (`visibility: "hide"`) are internal and skipped.
 */
function readCodexCatalog(): CatalogResult {
  const cachePath =
    process.env.CODEX_MODELS_CACHE_PATH ?? path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      models?: Array<{ slug?: string; display_name?: string; visibility?: string }>;
    };
    const rows = (raw.models ?? []).filter(
      (m): m is { slug: string; display_name?: string; visibility?: string } =>
        typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list'),
    );
    const models = [...new Set(rows.map((m) => m.slug))].sort();
    if (models.length === 0) return { models: [], source: 'observed' };

    const labels: Record<string, string> = {};
    for (const m of rows) {
      if (m.display_name && m.display_name !== m.slug) labels[m.slug] = m.display_name;
    }

    return {
      models,
      source: 'local_config',
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    };
  } catch {
    // No cache on disk — fall back to whatever the local logs have observed.
    return { models: [], source: 'observed' };
  }
}

/**
 * The Qwen CLI stores its configured plan + model list in ~/.qwen/settings.json.
 * The Alibaba ModelStudio Token Plan is a single subscription serving models
 * from several vendors, so this list is multi-vendor by design.
 */
function readQwenPlanCatalog(): CatalogResult {
  const settingsPath =
    process.env.QWEN_SETTINGS_PATH ?? path.join(os.homedir(), '.qwen', 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      modelProviders?: Record<string, Array<{ id?: string }>>;
    };
    const ids = Object.values(raw.modelProviders ?? {})
      .flat()
      .map((m) => m?.id)
      .filter((m): m is string => Boolean(m));
    if (ids.length === 0) return { models: [], source: 'unavailable', error: 'no models in qwen settings' };
    return { models: [...new Set(ids)].sort(), source: 'local_config' };
  } catch (err) {
    return { models: [], source: 'unavailable', error: (err as Error).message };
  }
}

// -----------------------------------------------------------------------------
// DeepInfra monthly per-model token usage
// -----------------------------------------------------------------------------
export interface MonthlyUsage {
  period: string;
  total_tokens: number;
  models: Array<{ model: string; tokens: number; cost_usd: number }>;
}

function period(d: Date): string {
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface UsageItem {
  model?: { model_name?: string } | null;
  units?: number;
  cost?: number; // cents
}

let monthlyCache: { at: number; data: MonthlyUsage | null } | null = null;

/**
 * Month-to-date token usage per model (15-minute cache). Falls back to the most
 * recent month with data when the current month has none yet.
 */
export async function fetchDeepInfraMonthly(): Promise<MonthlyUsage | null> {
  if (monthlyCache && Date.now() - monthlyCache.at < CATALOG_TTL_MS) return monthlyCache.data;
  const data = await fetchDeepInfraMonthlyUncached();
  monthlyCache = { at: Date.now(), data };
  return data;
}

async function fetchDeepInfraMonthlyUncached(): Promise<MonthlyUsage | null> {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) return null;

  const now = new Date();
  const current = period(now);
  const prev = period(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

  try {
    const data = await httpJson<{ months?: Array<{ period: string; items?: UsageItem[] }> }>(
      `https://api.deepinfra.com/payment/usage/tokens?from=${prev}&to=${current}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    const months = (data.months ?? []).map((m) => ({
      period: m.period,
      items: m.items ?? [],
      tokens: (m.items ?? []).reduce((s, it) => s + (it.units ?? 0), 0),
    }));
    months.sort((a, b) => a.period.localeCompare(b.period));

    const chosen =
      months.find((m) => m.period === current && m.tokens > 0) ??
      [...months].reverse().find((m) => m.tokens > 0) ??
      null;
    if (!chosen) return null;

    const byModel = new Map<string, { model: string; tokens: number; cost_usd: number }>();
    for (const it of chosen.items) {
      const name = it.model?.model_name ?? 'unknown';
      const cur = byModel.get(name) ?? { model: name, tokens: 0, cost_usd: 0 };
      cur.tokens += it.units ?? 0;
      cur.cost_usd += (it.cost ?? 0) / 100;
      byModel.set(name, cur);
    }

    return {
      period: chosen.period,
      total_tokens: chosen.tokens,
      models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    };
  } catch {
    return null;
  }
}
