// =============================================================================
// Express API server
// =============================================================================
// Endpoints:
//   GET /api/quota-state              → { state, summary }  (JSON)
//   GET /api/quota-state?format=text  → grouped text table   (text/plain)
//   GET /                            → same text table
//   GET /api/summary                  → alias for the text table
//   GET /api/health                   → liveness + state freshness
//
// Reads data/state.json fresh on every request (no caching) so the dashboard
// always sees the latest snapshot written by the scraper daemon. CORS is open
// by default because this is a local dev tool — bind only to 127.0.0.1.
// =============================================================================

// Load .env before reading any configuration.
import '../env.js';

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pickTopRecommendation } from '../scraper/calculator.js';
import { renderQuotaText, wantsText, wantsColor } from './text-render.js';
import { PROVIDER_ORDER } from '../types/quota.js';
import type {
  NormalizedQuotaBucket,
  Provider,
  QuotaStateFile,
  StatusGroup,
} from '../types/quota.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../../data/state.json');

const PORT = Number(process.env.API_PORT ?? 8787);
const HOST = process.env.API_HOST ?? '127.0.0.1';

// -----------------------------------------------------------------------------
// Zod schema for runtime validation — protects the API from a corrupted
// state.json if the scraper crashes mid-write.
// -----------------------------------------------------------------------------
const PROVIDER_ENUM = z.enum([
  'anthropic',
  'openai',
  'gemini',
  'moonshot',
  'minimax',
  'deepseek',
  'deepinfra',
  'qwen',
]);

const ResetCreditSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  reset_type: z.string().optional(),
  granted_at: z.string().optional(),
  expires_at: z.string().optional(),
});

const BucketSchema = z.object({
  model_id: z.string(),
  provider: PROVIDER_ENUM,
  account: z.string().optional(),
  display_name: z.string().optional(),
  window_label: z.string().optional(),
  tier_type: z.enum(['rolling_window', 'periodic_fixed', 'metered']),
  capacity: z.object({
    used_pct: z.number().min(0).max(100),
    reset_in_seconds: z.number().min(0),
    limit_window_hours: z.number().optional(),
    resets_at: z.string().optional(),
    balance_usd: z.number().optional(),
    spend_usd: z.number().optional(),
    spend_period_label: z.string().optional(),
    limit_label: z.string().optional(),
  }),
  waste_risk: z.enum(['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'NONE']),
  routing_priority: z.number(),
  waste_score: z.number().optional(),
  last_updated: z.string(),
  notes: z.string().optional(),
  reset_credits: z.array(ResetCreditSchema).optional(),
  unavailable: z.boolean().optional(),
  unavailable_reason: z.string().optional(),
});

const TokenTallySchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  total: z.number(),
  requests: z.number(),
});

const ModelUsageSchema = z.object({
  model: z.string(),
  display_name: z.string().optional(),
  windows: z.object({
    h1: TokenTallySchema,
    h5: TokenTallySchema,
    h24: TokenTallySchema,
  }),
  last_seen: z.string().optional(),
  in_catalog: z.boolean().optional(),
});

const ProviderModelsSchema = z.object({
  provider: PROVIDER_ENUM,
  account: z.string().optional(),
  catalog: z.array(z.string()),
  catalog_source: z.enum(['provider_api', 'local_config', 'observed', 'mixed', 'unavailable']),
  catalog_labels: z.record(z.string()).optional(),
  usage: z.array(ModelUsageSchema),
  usage_source: z.string(),
  last_activity: z.string().optional(),
  monthly: z
    .object({
      period: z.string(),
      total_tokens: z.number(),
      models: z.array(
        z.object({ model: z.string(), tokens: z.number(), cost_usd: z.number() }),
      ),
    })
    .optional(),
  note: z.string().optional(),
});

const StateSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string(),
  source: z.enum(['mock', 'real']),
  buckets: z.array(BucketSchema),
  provider_models: z.array(ProviderModelsSchema).optional(),
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function readState(): QuotaStateFile | null {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return StateSchema.parse(parsed) as QuotaStateFile;
  } catch (err) {
    console.error('[api] failed to read/validate state.json:', err);
    return null;
  }
}

const providerRank = (p: Provider): number => {
  const i = PROVIDER_ORDER.indexOf(p);
  return i === -1 ? PROVIDER_ORDER.length : i;
};

function sortProviders(providers: Iterable<Provider>): Provider[] {
  return [...new Set(providers)].sort((a, b) => providerRank(a) - providerRank(b));
}

/** Count buckets matching a predicate, and collect the providers behind them. */
function group(buckets: NormalizedQuotaBucket[], pred: (b: NormalizedQuotaBucket) => boolean): StatusGroup {
  const providers = new Set<Provider>();
  let count = 0;
  for (const b of buckets) {
    if (pred(b)) {
      count += 1;
      providers.add(b.provider);
    }
  }
  return { count, providers: sortProviders(providers) };
}

interface DashboardResponse {
  state: QuotaStateFile;
  summary: {
    total_buckets: number;
    total_providers: number;
    providers: Provider[];
    critical: StatusGroup;
    high: StatusGroup;
    exhausted: StatusGroup;
    unavailable: StatusGroup;
    metered: StatusGroup;
    metered_fallback: boolean;
    top_recommendation?: NormalizedQuotaBucket;
  };
}

function buildResponse(state: QuotaStateFile): DashboardResponse {
  const buckets = state.buckets;
  const allProviders = sortProviders([
    ...buckets.map((b) => b.provider),
    ...(state.provider_models ?? []).map((m) => m.provider),
  ]);

  return {
    state,
    summary: {
      total_buckets: buckets.length,
      total_providers: allProviders.length,
      providers: allProviders,
      critical: group(buckets, (b) => !b.unavailable && b.waste_risk === 'CRITICAL'),
      high: group(buckets, (b) => !b.unavailable && b.waste_risk === 'HIGH'),
      exhausted: group(buckets, (b) => !b.unavailable && b.routing_priority === 999),
      unavailable: group(buckets, (b) => Boolean(b.unavailable)),
      metered: group(buckets, (b) => !b.unavailable && b.tier_type === 'metered'),
      metered_fallback: buckets.some((b) => !b.unavailable && b.tier_type === 'metered'),
      top_recommendation: pickTopRecommendation(buckets),
    },
  };
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

app.get('/api/quota-state', (req, res) => {
  const state = readState();
  if (!state) {
    return res.status(503).json({
      error: 'state_unavailable',
      message: 'state.json not found or invalid — is the scraper running?',
    });
  }
  if (wantsText(req)) {
    res.type('text/plain; charset=utf-8').send(renderQuotaText(state, { color: wantsColor(req) }));
    return;
  }
  res.json(buildResponse(state));
});

// Convenience alias + bare-root text view so `curl 127.0.0.1:8787` just works.
const textHandler = (req: express.Request, res: express.Response) => {
  const state = readState();
  if (!state) {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('state.json not found or invalid — is the scraper running?\n');
    return;
  }
  res.type('text/plain; charset=utf-8').send(renderQuotaText(state, { color: wantsColor(req) }));
};

app.get('/api/summary', textHandler);
app.get('/', textHandler);

app.get('/api/health', (_req, res) => {
  const state = readState();
  res.json({
    ok: true,
    state_present: Boolean(state),
    state_generated_at: state?.generated_at ?? null,
    bucket_count: state?.buckets.length ?? 0,
    provider_count: state ? new Set(state.buckets.map((b) => b.provider)).size : 0,
    model_count: state
      ? (state.provider_models ?? []).reduce((s, m) => s + m.usage.length, 0)
      : 0,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`);
  console.log(`[api]   GET /api/quota-state            (JSON)`);
  console.log(`[api]   GET /api/quota-state?format=text (text table)`);
  console.log(`[api]   GET /api/summary                (text table alias)`);
  console.log(`[api]   GET /api/health`);
  console.log(`[api]   state.json → ${STATE_PATH}`);
});
