// =============================================================================
// Scraper daemon — orchestrator
// =============================================================================
// Runs every SCRAPE_INTERVAL seconds (default 60). Real provider scrapers are
// the default; pass --mock (or set USE_REAL_SCRAPERS=0) to use the local mock
// generator instead.
//
// Providers: Claude, ChatGPT (Codex), Kimi, MiniMax, DeepInfra, DeepSeek.
// Any provider that errors or lacks credentials emits an `unavailable` bucket
// so its card still renders with an explanation.
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
import { scrapeClaude } from './providers/claude.js';
import { scrapeChatGPT } from './providers/chatgpt.js';
import { scrapeGemini } from './providers/gemini.js';
import { scrapeKimi } from './providers/kimi.js';
import { scrapeMiniMax } from './providers/minimax.js';
import { scrapeDeepSeek } from './providers/deepseek.js';
import { scrapeDeepInfra } from './providers/deepinfra.js';
import { scrapeQwen } from './providers/qwen.js';
import { collectLocalUsage, rollup } from './usage/local-usage.js';
import { fetchCatalogs, fetchDeepInfraMonthly } from './usage/catalogs.js';
import { buildProviderModels } from './usage/build.js';
import type { QuotaStateFile } from '../types/quota.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../../data/state.json');

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

  // Provider quota windows, provider model catalogs, and local token usage are
  // all independent — run them together.
  const [quotaResults, localUsage, catalogs, diMonthly] = await Promise.all([
    Promise.all([
      safeCall('claude', scrapeClaude, []),
      safeCall('chatgpt', scrapeChatGPT, []),
      safeCall('gemini', scrapeGemini, []),
      safeCall('kimi', scrapeKimi, []),
      safeCall('minimax', scrapeMiniMax, []),
      safeCall('deepinfra', scrapeDeepInfra, []),
      safeCall('deepseek', scrapeDeepSeek, []),
      safeCall('qwen', scrapeQwen, []),
    ]),
    safeCall('local-usage', collectLocalUsage, {
      events: [],
      sourcesScanned: [],
      sourcesMissing: [],
      sourceLatest: {},
      sourceFiles: {},
    }),
    safeCall('catalogs', fetchCatalogs, null),
    safeCall('deepinfra-monthly', fetchDeepInfraMonthly, null),
  ]);

  const raw = quotaResults.flat();
  const buckets = sortByRoutingPriority(raw.map(enrichBucket));

  const provider_models = catalogs
    ? buildProviderModels({
        catalogs,
        rollups: rollup(localUsage.events),
        monthly: diMonthly,
        local: localUsage,
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
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
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
    `[scraper:${state.source}] wrote ${state.buckets.length} buckets in ${dt}ms — ${summary}`,
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