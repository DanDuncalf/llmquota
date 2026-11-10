// =============================================================================
// Shared provider helpers
// =============================================================================
// Common types and utilities used by every provider scraper. Keep this file
// dependency-free (no fs, no fetch) so it can be unit-tested in isolation.
// =============================================================================

import type { NormalizedQuotaBucket, Provider, TierType } from '../../types/quota.js';

/** Shape a scraper produces BEFORE enrichment. Calculator fills in risk fields. */
export type RawBucket = Omit<
  NormalizedQuotaBucket,
  'waste_risk' | 'routing_priority' | 'waste_score'
>;

/** A provider scraper returns a list of raw buckets, possibly empty on error. */
export type ProviderScraper = () => Promise<RawBucket[]>;

export interface ProviderSpec {
  provider: Provider;
  default_tier_type: TierType;
}

/** Build a reset timestamp ISO string from now + offset seconds. */
export function futureIso(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

/** Clamp a value into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Tiny deterministic pseudo-random — useful for mock generators that should
 * produce stable-but-varied values across runs (seed from clock minute).
 */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------------------------
// HTTP helpers (network-bound — used only by real provider scrapers)
// -----------------------------------------------------------------------------

/** Default per-request timeout. Keeps a hung provider from stalling the tick. */
export const HTTP_TIMEOUT_MS = Number(process.env.SCRAPE_HTTP_TIMEOUT_MS ?? 15_000);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

/** GET/POST a URL and parse JSON, with a hard timeout and retries. Throws HttpError on non-2xx. */
export async function httpJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<T> {
  const attempts = Math.max(1, Number(process.env.SCRAPE_HTTP_RETRIES ?? 3));
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 400));
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      lastErr = err;
      // Auth / not-found errors will never succeed on retry — fail fast.
      if (err instanceof HttpError && err.status < 500) throw err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Seconds until the next Sunday 00:00 UTC — shared by weekly-cap providers. */
export function secondsUntilSundayUtc(now: Date = new Date()): number {
  const next = new Date(now);
  const daysUntilSunday = (7 - next.getUTCDay()) % 7;
  next.setUTCDate(next.getUTCDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  next.setUTCHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/** Clamp a percentage into [0, 100] and round to one decimal. */
export function pct(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const v = (used / limit) * 100;
  return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

/** Build an `unavailable` bucket so the UI can show *why* a window is missing. */
export function unavailableBucket(args: {
  model_id: string;
  provider: Provider;
  display_name: string;
  window_label?: string;
  tier_type: TierType;
  reason: string;
  limit_label?: string;
}): RawBucket {
  return {
    model_id: args.model_id,
    provider: args.provider,
    display_name: args.display_name,
    window_label: args.window_label,
    tier_type: args.tier_type,
    capacity: {
      used_pct: 0,
      reset_in_seconds: 0,
      limit_label: args.limit_label,
    },
    last_updated: new Date().toISOString(),
    notes: args.reason,
    unavailable: true,
    unavailable_reason: args.reason,
  };
}