// =============================================================================
// Express API server
// =============================================================================
// Endpoints:
//   GET /api/quota-state              → { state, summary }  (JSON)
//   GET /api/quota-state?format=text  → grouped text table   (text/plain)
//   GET /                            → same text table
//   GET /api/summary                  → alias for the text table
//   GET /api/health                   → liveness + state freshness
//   POST /api/cards/:id/refresh       → re-scrape one card into state.json
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
import {
  cardRank,
  deleteCard,
  findCard,
  loadRegistry,
  saveCard,
} from '../cards/registry.js';
import { scrapeCardNow } from '../scraper/collect.js';
import { sortByRoutingPriority } from '../scraper/calculator.js';
import type { CardLoadError, LoadedCard } from '../cards/registry.js';
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
// Provider ids are validated against the card registry, not a hardcoded enum:
// cards are data (config/cards/*.json), so the enum would be a second source of
// truth that drifts every time a card is added.
const ProviderId = z.string().min(1).max(64);

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
  provider: ProviderId,
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
  provider: ProviderId,
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

const providerRank = (p: Provider): number => cardRank(p);

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
  /** Card specs travel with the data so the UI can render without a rebuild. */
  cards: LoadedCard[];
  card_errors: CardLoadError[];
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
  const registry = loadRegistry();
  const hidden = new Set(registry.cards.filter((c) => !c.shown).map((c) => c.id));

  // Hidden cards are templates, not capacity: exclude them (and any stale
  // buckets they left in the snapshot) from every summary number.
  const buckets = state.buckets.filter((b) => !hidden.has(b.provider));
  const models = (state.provider_models ?? []).filter((m) => !hidden.has(m.provider));

  const allProviders = sortProviders([
    ...registry.cards.filter((c) => c.shown).map((c) => c.id),
    ...buckets.map((b) => b.provider),
    ...models.map((m) => m.provider),
  ]);

  return {
    state,
    cards: registry.cards,
    card_errors: registry.errors,
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
  const registry = loadRegistry();
  const cardIds = new Set(registry.cards.map((c) => c.id));
  const bucketProviders = new Set((state?.buckets ?? []).map((b) => b.provider));

  res.json({
    ok: true,
    state_present: Boolean(state),
    state_generated_at: state?.generated_at ?? null,
    bucket_count: state?.buckets.length ?? 0,
    provider_count: bucketProviders.size,
    model_count: state
      ? (state.provider_models ?? []).reduce((s, m) => s + m.usage.length, 0)
      : 0,
    card_count: registry.cards.length,
    card_errors: registry.errors,
    // Data with no card (still rendered generically) and cards with no data
    // (JSON-only cards, or a scraper that has not ticked yet).
    orphan_providers: [...bucketProviders].filter((p) => !cardIds.has(p)),
    cards_without_data: registry.cards
      .filter((c) => c.shown)
      .map((c) => c.id)
      .filter((id) => !bucketProviders.has(id)),
    cards_hidden: registry.cards.filter((c) => !c.shown).length,
    card_dirs: registry.dirs,
  });
});

// -----------------------------------------------------------------------------
// Card CRUD — cards are JSON files; these endpoints edit them in place.
// -----------------------------------------------------------------------------
app.get('/api/cards', (_req, res) => {
  const registry = loadRegistry();
  res.json({
    cards: registry.cards,
    errors: registry.errors,
    dirs: registry.dirs,
    writable_dir: registry.dirs[registry.dirs.length - 1],
  });
});

// PUT is an upsert: the id in the path is authoritative, so a card can never be
// written to a different file than the one requested.
app.put('/api/cards/:id', (req, res) => {
  const result = saveCard(req.params.id, req.body);
  if (!result.ok) {
    return res.status(result.status).json({ ok: false, errors: result.errors });
  }
  res.status(result.status).json({ ok: true, card: result.card, errors: [] });
});

app.delete('/api/cards/:id', (req, res) => {
  const result = deleteCard(req.params.id);
  if (!result.ok) {
    return res.status(result.status).json({ ok: false, errors: result.errors });
  }
  res.json({ ok: true, file: result.file, errors: [] });
});

// Scrape one card on demand and merge its fresh buckets into state.json, so
// the dashboard grid updates immediately instead of waiting for the next
// daemon tick. Only quota buckets are replaced — provider_models (catalogs /
// local log rollups) refresh on the next full tick. `generated_at` stays the
// daemon's tick time: a per-card refresh does not make the rest of the
// snapshot fresher than it is.
app.post('/api/cards/:id/refresh', async (req, res) => {
  const card = findCard(req.params.id);
  if (!card) return res.status(404).json({ ok: false, errors: [`no card "${req.params.id}"`] });

  const state = readState();
  if (!state) {
    return res.status(503).json({ ok: false, errors: ['state.json not found or invalid'] });
  }
  if (state.source !== 'real') {
    return res
      .status(409)
      .json({ ok: false, errors: ['state snapshot is mock — refresh is disabled in mock mode'] });
  }

  try {
    const fresh = await scrapeCardNow(card);
    // Read-modify-write against the daemon's file: the atomic rename keeps a
    // reader from seeing a torn write; a daemon tick landing mid-merge is
    // re-written on its next pass (60s), which is acceptable for a local tool.
    const current = readState() ?? state;
    current.buckets = sortByRoutingPriority([
      ...current.buckets.filter((b) => b.provider !== card.id),
      ...fresh,
    ]);
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    res.json({ ok: true, buckets: fresh.length, errors: [] });
  } catch (err) {
    console.error(`[api] refresh ${card.id} failed:`, err);
    res.status(500).json({
      ok: false,
      errors: [`scrape failed: ${err instanceof Error ? err.message : String(err)}`],
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`);
  console.log(`[api]   GET /api/quota-state            (JSON)`);
  console.log(`[api]   GET /api/quota-state?format=text (text table)`);
  console.log(`[api]   GET /api/summary                (text table alias)`);
  console.log(`[api]   GET /api/health`);
  console.log(`[api]   GET /api/cards`);
  console.log(`[api]   PUT /api/cards/:id    (create/update one card JSON)`);
  console.log(`[api]   DELETE /api/cards/:id (remove one card JSON)`);
  console.log(`[api]   POST /api/cards/:id/refresh (re-scrape one card into state.json)`);
  console.log(`[api]   cards → ${loadRegistry().dirs.join(', ')}`);
  console.log(`[api]   state.json → ${STATE_PATH}`);
});
