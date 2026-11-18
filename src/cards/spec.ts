// =============================================================================
// Card specification — the data contract for one dashboard card
// =============================================================================
// A card is DATA, not code. One JSON file per card (see src/cards/registry.ts)
// declares everything the dashboard needs to render it:
//
//   identity  → id, label, company, console url, palette, sort order
//   windows[] → the quota rows the card expects, in display order
//   usage     → where model catalogs / token logs come from
//   agent     → query aliases + CLI harness hints for the `llmquota` agent
//
// The scraper only supplies MEASUREMENTS (used %, reset, balance); the card
// decides which measurements exist and how each one is displayed. A declared
// window with no measurement renders as UNAVAILABLE instead of disappearing.
//
// Runtime rules:
//   * This module may import zod (server + scraper validate with it).
//   * The UI imports TYPES ONLY from here (`import type`), so zod never lands
//     in the browser bundle.
// =============================================================================

import { z } from 'zod';
import {
  ID_PATTERN,
  PALETTE_NAMES,
  WINDOW_DISPLAYS,
  WINDOW_KINDS,
  WINDOW_TIERS,
} from './vocab.js';

// Vocabulary (palette names, window kinds/tiers/displays, id pattern) lives in
// ./vocab.ts so browser code can use the runtime arrays without pulling zod
// into the UI bundle.
export {
  ID_PATTERN,
  PALETTE_NAMES,
  WINDOW_DISPLAYS,
  WINDOW_KINDS,
  WINDOW_TIERS,
} from './vocab.js';
export type { PaletteName, WindowDisplay, WindowKind, WindowTier } from './vocab.js';

export const CardWindowSchema = z.object({
  /** Must match the `model_id` the scraper emits for this window. */
  id: z
    .string()
    .regex(ID_PATTERN, 'window id must be lowercase letters, digits, "-" or "_"'),
  /** Row label, e.g. "5h session". */
  label: z.string().min(1).max(64),
  kind: z.enum(WINDOW_KINDS).default('other'),
  tier: z.enum(WINDOW_TIERS).default('rolling_window'),
  /** Window length in hours — drives ordering and the agent's "weekly" view. */
  hours: z.number().positive().max(24 * 400).optional(),
  display: z.enum(WINDOW_DISPLAYS).default('percent'),
  /** Small grey caption under the row, e.g. "Pro plan". */
  limit_label: z.string().max(120).optional(),
});

const CardSpecObjectSchema = z.object({
  id: z
    .string()
    .regex(ID_PATTERN, 'id must be lowercase letters, digits, "-" or "_"')
    .max(64),
  label: z.string().min(1).max(64),
  company: z.string().max(64).optional(),
  url: z.string().url().max(300).optional(),
  palette: z.enum(PALETTE_NAMES).default('zinc'),
  /** Ascending sort rank. Ties fall back to label. Lower = further left. */
  order: z.number().int().min(0).max(10_000).default(1000),
  aliases: z.array(z.string().min(1).max(48)).max(32).default([]),
  /**
   * Shipped template cards default to hidden: they appear in the Cards view
   * (with their identity, palette, URL and aliases) but stay off the dashboard
   * until you show them or until the scraper reports buckets for them.
   * Legacy name `enabled` is still accepted as an alias on input.
   */
  shown: z.boolean().default(true),
  /** Declared windows. Empty means "render whatever the scraper reports". */
  windows: z.array(CardWindowSchema).max(24).default([]),
  usage: z
    .object({
      /** Catalog source id, e.g. "api:deepseek", "local:qwen", "observed". */
      catalog: z.string().max(64).optional(),
      /** Local CLI log family scanned for token usage, e.g. "claude". */
      logs: z.string().max(64).nullable().optional(),
      /** Billing API reports month-granularity tokens (DeepInfra). */
      monthly: z.boolean().optional(),
      /** A platform usage API feeds this card ("deepseek"). */
      platform: z.string().max(32).optional(),
    })
    .default({}),
  agent: z
    .object({
      /** CLI harness that serves this plan, e.g. "agy". */
      harness: z.string().max(32).optional(),
      /** Model ids the harness advertises, used only for query matching. */
      serves: z.array(z.string().max(64)).max(200).optional(),
    })
    .optional(),
  notes: z.string().max(500).optional(),
});

export const CardSpecSchema = z.preprocess(
  (raw) => {
    // Legacy rename: `enabled` (pre-show/hide terminology) becomes `shown`.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.shown === undefined && typeof obj.enabled === 'boolean') {
        const { enabled, ...rest } = obj;
        return { ...rest, shown: enabled };
      }
    }
    return raw;
  },
  CardSpecObjectSchema,
) as unknown as z.ZodType<CardSpec, z.ZodTypeDef, CardSpecInput>;

/** Validated + defaulted card (what consumers see). */
export type CardSpec = z.infer<typeof CardSpecObjectSchema>;
/** What a caller may send (defaults optional). */
export type CardSpecInput = z.input<typeof CardSpecObjectSchema>;
export type CardWindow = z.infer<typeof CardWindowSchema>;

/** Canonical key order for the on-disk JSON — keeps diffs readable. */
export function toFileJson(card: CardSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: card.id, label: card.label };
  if (card.company) out.company = card.company;
  if (card.url) out.url = card.url;
  out.palette = card.palette;
  out.order = card.order;
  out.aliases = card.aliases;
  if (!card.shown) out.shown = false;
  out.windows = card.windows.map((w) => {
    const row: Record<string, unknown> = {
      id: w.id,
      label: w.label,
      kind: w.kind,
      tier: w.tier,
    };
    if (w.hours !== undefined) row.hours = w.hours;
    row.display = w.display;
    if (w.limit_label) row.limit_label = w.limit_label;
    return row;
  });
  if (card.usage && Object.keys(card.usage).length > 0) out.usage = card.usage;
  if (card.agent) out.agent = card.agent;
  if (card.notes) out.notes = card.notes;
  return out;
}

/** A brand-new card as the editor opens it. */
export function draftCard(id = ''): CardSpecInput {
  return {
    id,
    label: id,
    palette: 'zinc',
    order: 500,
    aliases: [],
    windows: [],
    usage: {},
  };
}

/** One empty window row, for the editor's "add window" button. */
export function draftWindow(): CardWindow {
  return { id: '', label: '', kind: 'other', tier: 'rolling_window', display: 'percent' };
}
