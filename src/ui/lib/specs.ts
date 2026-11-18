// =============================================================================
// Card spec helpers (client side)
// =============================================================================
// The dashboard renders from card specs received over HTTP. Anything a card
// does not declare still renders — via these fallbacks — so a bucket whose
// provider has no card (or a card whose window was added later) never breaks
// the page.
// =============================================================================

import type { CardSpec, CardWindow, WindowDisplay } from '../../cards/spec.js';
import type { NormalizedQuotaBucket } from '../../types/quota.js';
import type { LoadedCard } from './api.js';

export interface CardLike extends CardSpec {
  source?: 'shipped' | 'user';
}

/** Generic spec for buckets whose provider has no card file. */
export function fallbackSpec(provider: string): CardLike {
  return {
    id: provider,
    label: provider,
    palette: 'zinc',
    order: 10_000,
    aliases: [],
    shown: true,
    windows: [],
    usage: {},
  };
}

export function specMap(cards?: LoadedCard[] | CardLike[]): Map<string, CardLike> {
  const map = new Map<string, CardLike>();
  for (const card of cards ?? []) map.set(card.id, card);
  return map;
}

export function specFor(map: Map<string, CardLike>, provider: string): CardLike {
  return map.get(provider) ?? fallbackSpec(provider);
}

/** The declared window a bucket belongs to, if any. */
export function windowFor(spec: CardLike, bucket: NormalizedQuotaBucket): CardWindow | undefined {
  return spec.windows.find((w) => w.id === bucket.model_id);
}

/**
 * Display primitive for a row: declared by the window, else inferred from the
 * tier (metered rows show money, everything else shows a percentage bar).
 */
export function displayOf(spec: CardLike, bucket: NormalizedQuotaBucket): WindowDisplay {
  return windowFor(spec, bucket)?.display ?? (bucket.tier_type === 'metered' ? 'currency' : 'percent');
}

/** Row label: declared window label wins, then the scraper's own label. */
export function labelOf(spec: CardLike, bucket: NormalizedQuotaBucket): string {
  return (
    windowFor(spec, bucket)?.label ??
    bucket.window_label ??
    bucket.display_name ??
    bucket.model_id
  );
}

/** Sort index within the card: declared windows first, in JSON order. */
export function orderIndexOf(spec: CardLike, bucket: NormalizedQuotaBucket): number {
  const index = spec.windows.findIndex((w) => w.id === bucket.model_id);
  return index === -1 ? spec.windows.length : index;
}

export function hoursOf(spec: CardLike, bucket: NormalizedQuotaBucket): number {
  return windowFor(spec, bucket)?.hours ?? bucket.capacity.limit_window_hours ?? 999;
}

/** Weekly-cap window: declared `kind`, then a conservative heuristic. */
export function isWeeklyBucket(spec: CardLike, bucket: NormalizedQuotaBucket): boolean {
  const declared = windowFor(spec, bucket);
  if (declared) return declared.kind === 'weekly';
  const hours = bucket.capacity.limit_window_hours ?? 0;
  return hours >= 24 || /week/i.test(`${bucket.window_label ?? ''} ${bucket.model_id}`);
}

/** "deepinfra.com" for a console URL; empty string when the card has none. */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Bucket rows in the card's declared order, metered last, then by usage. */
export function orderBuckets(
  spec: CardLike,
  buckets: NormalizedQuotaBucket[],
): NormalizedQuotaBucket[] {
  return [...buckets].sort((a, b) => {
    const oa = orderIndexOf(spec, a);
    const ob = orderIndexOf(spec, b);
    if (oa !== ob) return oa - ob;
    const am = a.tier_type === 'metered' ? 1 : 0;
    const bm = b.tier_type === 'metered' ? 1 : 0;
    if (am !== bm) return am - bm;
    const ah = hoursOf(spec, a);
    const bh = hoursOf(spec, b);
    if (ah !== bh) return ah - bh;
    return b.capacity.used_pct - a.capacity.used_pct;
  });
}

/** The bucket that should headline this card. */
export function leadBucket(
  spec: CardLike,
  buckets: NormalizedQuotaBucket[],
): NormalizedQuotaBucket | undefined {
  const routable = buckets.filter((b) => !b.unavailable);
  const pool = routable.length > 0 ? routable : buckets;
  return [...pool].sort((a, b) => a.routing_priority - b.routing_priority)[0];
}
