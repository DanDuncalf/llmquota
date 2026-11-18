// =============================================================================
// Scraper daemon — orchestrator
// =============================================================================
// Runs every SCRAPE_INTERVAL seconds (default 60). Real provider scrapers are
// the default; pass --mock (or set USE_REAL_SCRAPERS=0) to use the local mock
// generator instead.
//
// The list of cards is DATA: it comes from the card registry (config/cards/ +
// data/cards/), re-read on every tick. A card with no registered scraper still
// renders — as UNAVAILABLE, with a reason — so adding a card is a JSON-only
// operation until you want real numbers for it.
//
// Usage:
//   npm run scrape          # real data (default)
//   npm run scrape:mock     # force mock
//   npm run dev             # scraper (real) + server + UI
//   npm run dev:mock        # scraper (mock) + server + UI
// =============================================================================

// Load .env before any module reads process.env at import time.
import '../env.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichBucket, sortByRoutingPriority } from './calculator.js';
import { generateMockState } from './mock-generator.js';
import { collectCardBuckets } from './collect.js';
import { loadRegistry } from '../cards/registry.js';
import { collectLocalUsage, rollup } from './usage/local-usage.js';
import { fetchCatalogs, fetchDeepInfraMonthly } from './usage/catalogs.js';
import { fetchDeepSeekPlatformUsage } from './usage/deepseek-platform.js';
import { buildProviderModels } from './usage/build.js';
import type { QuotaStateFile } from '../types/quota.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../../data/state.json');

/**
 * Where this tick writes. The daemon owns data/state.json; out-of-band callers
 * (the agent's one-shot refresh, scripts) pass --out=PATH or SCRAPE_OUT so they
 * can never clobber a fresher daemon snapshot — or worse, overwrite it with a
 * degraded one when their process happens to lack provider credentials.
 */
function resolveOutputPath(argv: string[]): string {
  const inline = argv.find((a) => a.startsWith('--out='));
  const fromArg = inline ? inline.slice('--out='.length) : undefined;
  const chosen = fromArg ?? process.env.SCRAPE_OUT;
  return chosen ? path.resolve(chosen) : STATE_PATH;
}
const OUTPUT_PATH = resolveOutputPath(process.argv.slice(2));

// -----------------------------------------------------------------------------
// CLI flags
// -----------------------------------------------------------------------------
// Real data is the DEFAULT. Use --mock (or USE_REAL_SCRAPERS=0) for the
// drifting mock generator.
const args = new Set(process.argv.slice(2));
const hasFlagMock = args.has('--mock');
const hasFlagReal = args.has('--real');
const envForcedMock = process.env.USE_REAL_SCRAPERS === '0';
const useMock = hasFlagMock || (!hasFlagReal && envForcedMock);

const intervalSec = Math.max(10, Number(process.env.SCRAPE_INTERVAL ?? 60));

// -----------------------------------------------------------------------------
// Real-mode orchestrator
// -----------------------------------------------------------------------------
async function collectReal(): Promise<QuotaStateFile> {
  const nowIso = new Date().toISOString();

  // Reload cards every tick so a card added/edited on disk shows up within one
  // interval, with no daemon restart.
  const registry = loadRegistry();
  for (const e of registry.errors) {
    console.error(`[scraper] card error in ${e.file}: ${e.message}`);
  }

  // Card quotas, provider model catalogs, and local token usage are all
  // independent — run them together.
  const [quotaResults, localUsage, catalogs, diMonthly, deepseekPlatform] = await Promise.all([
    collectCardBuckets(registry.cards),
    safeCall('local-usage', collectLocalUsage, {
      events: [],
      sourcesScanned: [],
      sourcesMissing: [],
      sourceLatest: {},
      sourceFiles: {},
    }),
    safeCall('catalogs', fetchCatalogs, null),
    safeCall('deepinfra-monthly', fetchDeepInfraMonthly, null),
    safeCall('deepseek-platform', fetchDeepSeekPlatformUsage, null),
  ]);

  const raw = quotaResults;
  const buckets = sortByRoutingPriority(raw.map(enrichBucket));

  const provider_models = catalogs
    ? buildProviderModels({
        catalogs,
        rollups: rollup(localUsage.events),
        monthly: diMonthly,
        local: localUsage,
        deepseekPlatform,
      })
    : undefined;

  return {
    schema_version: 1,
    generated_at: nowIso,
    source: 'real',
    buckets,
    provider_models,
  };
}

async function safeCall<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[scraper] ${name} failed:`, err);
    return fallback;
  }
}

function writeState(state: QuotaStateFile): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const tmp = OUTPUT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, OUTPUT_PATH);
}

// -----------------------------------------------------------------------------
// Daemon loop
// -----------------------------------------------------------------------------
async function tick(): Promise<void> {
  const t0 = Date.now();
  const state = useMock ? generateMockState() : await collectReal();
  writeState(state);
  const dt = Date.now() - t0;
  const summary = state.buckets
    .map((b) => `${b.model_id}:${b.waste_risk}/${b.capacity.used_pct.toFixed(1)}%`)
    .join('  ');
  console.log(
    `[scraper:${state.source}] wrote ${state.buckets.length} buckets to ${OUTPUT_PATH} in ${dt}ms — ${summary}`,
  );
}

function startDaemon(): void {
  console.log(
    `[scraper] starting in ${useMock ? 'MOCK' : 'REAL'} mode, interval=${intervalSec}s`,
  );
  // Run once immediately so the dashboard has data on first paint.
  tick().catch((err) => console.error('[scraper] initial tick failed:', err));
  setInterval(() => {
    tick().catch((err) => console.error('[scraper] tick failed:', err));
  }, intervalSec * 1000);
}

function runOnce(): void {
  tick()
    .then(() => {
      console.log('[scraper] one-shot complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scraper] one-shot failed:', err);
      process.exit(1);
    });
}

// --once flag → exit after first tick (useful for cron jobs)
if (args.has('--once')) {
  runOnce();
} else {
  startDaemon();
}