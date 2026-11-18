// =============================================================================
// Scraper collection — registry + per-card collection
// =============================================================================
// Shared by the daemon (src/scraper/index.ts, every tick) and the API
// (src/server/index.ts, POST /api/cards/:id/refresh). Kept in its own module
// so importing it has no daemon-loop side effects.
// =============================================================================

import { reconcileCardWindows, synthesizeUnavailable } from './cards.js';
import { enrichBucket, sortByRoutingPriority } from './calculator.js';
import { scrapeClaude } from './providers/claude.js';
import { scrapeChatGPT } from './providers/chatgpt.js';
import { scrapeGemini } from './providers/gemini.js';
import { scrapeKimi } from './providers/kimi.js';
import { scrapeMiniMax } from './providers/minimax.js';
import { scrapeDeepSeek } from './providers/deepseek.js';
import { scrapeDeepInfra } from './providers/deepinfra.js';
import { scrapeQwen } from './providers/qwen.js';
import type { ProviderScraper, RawBucket } from './providers/base.js';
import type { LoadedCard } from '../cards/registry.js';
import type { NormalizedQuotaBucket } from '../types/quota.js';

// -----------------------------------------------------------------------------
// Scraper registry — keyed by card id. A card without an entry here still gets
// a card; it just has no measurements (JSON-only cards).
// -----------------------------------------------------------------------------
export const SCRAPERS: Record<string, ProviderScraper> = {
  anthropic: scrapeClaude,
  openai: scrapeChatGPT,
  gemini: scrapeGemini,
  moonshot: scrapeKimi,
  minimax: scrapeMiniMax,
  deepinfra: scrapeDeepInfra,
  deepseek: scrapeDeepSeek,
  qwen: scrapeQwen,
};

/** Scrape one card and reconcile the result with its declared windows. Never
 *  throws: a failing scraper becomes an UNAVAILABLE card. */
async function scrapeOneCard(card: LoadedCard): Promise<RawBucket[]> {
  const scraper = SCRAPERS[card.id];
  if (!scraper) {
    return synthesizeUnavailable(
      card,
      'no scraper registered for this card yet — showing the card without measurements',
    );
  }
  try {
    return reconcileCardWindows(card, await scraper());
  } catch (err) {
    console.error(`[scraper] ${card.id} failed:`, err);
    return synthesizeUnavailable(
      card,
      `scrape failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run the given cards' scrapers (hidden cards skipped — they are templates
 * that live in the Cards view only). Used by the daemon tick.
 */
export async function collectCardBuckets(cards: LoadedCard[]): Promise<RawBucket[]> {
  const results = await Promise.all(
    cards.map(async (card) => (card.shown ? scrapeOneCard(card) : [])),
  );
  return results.flat();
}

/**
 * Scrape a single card NOW and return its enriched buckets — for the API's
 * per-card refresh. Unlike the daemon pass this runs even for hidden cards:
 * the caller decides whether merging them into state.json makes sense.
 */
export async function scrapeCardNow(card: LoadedCard): Promise<NormalizedQuotaBucket[]> {
  const raw = await scrapeOneCard(card);
  return sortByRoutingPriority(raw.map(enrichBucket));
}
