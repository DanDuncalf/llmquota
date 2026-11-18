// =============================================================================
// Card → bucket reconciliation
// =============================================================================
// The card spec declares which windows a card HAS. The scraper supplies the
// measurements. This module bridges the two so a card never silently loses a
// row when a provider stops reporting it:
//
//   card declares 2 windows, scraper returns 1  → the missing one is UNAVAILABLE
//   card declares 0 windows (dynamic, e.g. one row per Google account) → as-is
//   scraper already returned an unavailable bucket (it explained itself) → as-is
//   no scraper registered for the card → every declared window UNAVAILABLE
//
// Never fabricates a number: synthesized buckets carry used_pct 0 + unavailable.
// =============================================================================

import { unavailableBucket } from './providers/base.js';
import type { RawBucket } from './providers/base.js';
import type { LoadedCard } from '../cards/registry.js';
import type { CardWindow } from '../cards/spec.js';

/** One declared window, rendered as UNAVAILABLE with a reason. */
export function bucketForWindow(
  card: LoadedCard,
  window: CardWindow,
  reason: string,
): RawBucket {
  return unavailableBucket({
    model_id: window.id,
    provider: card.id,
    display_name: `${card.label} · ${window.label}`,
    window_label: window.label,
    tier_type: window.tier,
    reason,
    limit_label: window.limit_label,
  });
}

/**
 * Every declared window as UNAVAILABLE. Cards that declare no windows get a
 * single placeholder row so the card still explains itself.
 */
export function synthesizeUnavailable(card: LoadedCard, reason: string): RawBucket[] {
  if (card.windows.length === 0) {
    return [
      unavailableBucket({
        model_id: `${card.id}-plan`,
        provider: card.id,
        display_name: card.label,
        window_label: card.label,
        tier_type: 'rolling_window',
        reason,
        limit_label: card.notes,
      }),
    ];
  }
  return card.windows.map((w) => bucketForWindow(card, w, reason));
}

/**
 * Add UNAVAILABLE rows for declared windows the scraper did not report.
 *
 * Skipped when the scraper already produced any unavailable bucket: a provider
 * that returns a single "plan unavailable" row has told the whole story, and
 * adding a row per declared window on top of it would just be noise.
 */
export function reconcileCardWindows(
  card: LoadedCard,
  delivered: RawBucket[],
): RawBucket[] {
  if (card.windows.length === 0 || delivered.some((b) => b.unavailable)) {
    return delivered;
  }
  const seen = new Set(delivered.map((b) => b.model_id));
  const missing = card.windows.filter((w) => !seen.has(w.id));
  return [
    ...delivered,
    ...missing.map((w) => bucketForWindow(card, w, 'not reported by provider')),
  ];
}
