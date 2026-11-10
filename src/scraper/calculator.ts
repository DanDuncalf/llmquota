// =============================================================================
// Waste Risk Calculator
// =============================================================================
// Pure functions. No I/O. Given a NormalizedQuotaBucket (with raw used_pct and
// reset_in_seconds already populated by the scraper), this module assigns:
//
//   - waste_risk         : CRITICAL | HIGH | MODERATE | LOW | NONE
//   - routing_priority   : lower = use sooner (see types/quota.ts)
//   - waste_score        : raw score for sorting / debugging
//
// The business rules are documented inline. The scraper calls enrichBucket()
// once per bucket before persisting to data/state.json.
// =============================================================================

import type {
  NormalizedQuotaBucket,
  TierType,
  WasteRiskLevel,
} from '../types/quota.js';

/** Routing priority constants — exported so the UI can render them consistently. */
export const PRIORITY = {
  CRITICAL: 1,
  HIGH: 5,
  MODERATE: 10,
  LOW: 20,
  METERED_FALLBACK: 99,
  EXHAUSTED: 999,
} as const;

const SECONDS_PER_HOUR = 3600;

export interface RiskComputation {
  waste_risk: WasteRiskLevel;
  routing_priority: number;
  waste_score: number;
}

/**
 * Compute the raw waste score from the spec formula:
 *
 *     Waste Score = (100 - used_pct) / max(1, hours_until_reset)
 *
 * Higher score = more free capacity is about to expire unused = bigger waste
 * if we don't route requests to this bucket.
 *
 * Used internally by classifyRisk() — exposed via the enrichment result so the
 * UI can show it as a tooltip / sort signal.
 */
export function computeWasteScore(used_pct: number, reset_in_seconds: number): number {
  const free_pct = Math.max(0, 100 - used_pct);
  const hours_until_reset = Math.max(1 / 3600, reset_in_seconds / SECONDS_PER_HOUR);
  return free_pct / hours_until_reset;
}

/**
 * Classify a bucket into a WasteRiskLevel + routing_priority using the spec
 * decision tree:
 *
 *   1. used_pct >= 99          → NONE, priority 999  (exhausted / cooldown)
 *   2. tier_type == 'metered'  → NONE, priority 99   (paid overflow)
 *   3. hours_until_reset < 24  and used_pct < 40   → CRITICAL, priority 1
 *   4. hours_until_reset < 48  and used_pct < 60   → HIGH,     priority 5
 *   5. else                                          MODERATE  priority 10
 *                                                   LOW       priority 20
 */
export function classifyRisk(
  used_pct: number,
  reset_in_seconds: number,
  tier_type: TierType,
): RiskComputation {
  const waste_score = computeWasteScore(used_pct, reset_in_seconds);
  const hours_until_reset = reset_in_seconds / SECONDS_PER_HOUR;

  // Rule 1: exhausted
  if (used_pct >= 99) {
    return { waste_risk: 'NONE', routing_priority: PRIORITY.EXHAUSTED, waste_score };
  }

  // Rule 2: metered — paid fallback, never block routing on it
  if (tier_type === 'metered') {
    return { waste_risk: 'NONE', routing_priority: PRIORITY.METERED_FALLBACK, waste_score };
  }

  // Rule 3: CRITICAL — lots of unused capacity expiring in under 24h
  if (hours_until_reset < 24 && used_pct < 40) {
    return { waste_risk: 'CRITICAL', routing_priority: PRIORITY.CRITICAL, waste_score };
  }

  // Rule 4: HIGH — meaningful unused capacity, expiring in under 48h
  if (hours_until_reset < 48 && used_pct < 60) {
    return { waste_risk: 'HIGH', routing_priority: PRIORITY.HIGH, waste_score };
  }

  // Rule 5: otherwise — default to MODERATE, drop to LOW if heavily used
  if (used_pct >= 80) {
    return { waste_risk: 'LOW', routing_priority: PRIORITY.LOW, waste_score };
  }
  return { waste_risk: 'MODERATE', routing_priority: PRIORITY.MODERATE, waste_score };
}

/**
 * Enrich a raw bucket (used_pct + reset_in_seconds populated, waste_risk and
 * routing_priority not yet set) with computed risk fields. Returns a new object;
 * does not mutate the input.
 */
export function enrichBucket(
  bucket: Omit<NormalizedQuotaBucket, 'waste_risk' | 'routing_priority' | 'waste_score'>,
): NormalizedQuotaBucket {
  // Unavailable windows (missing credential, no active plan, provider error)
  // must never be routed to, and must not pollute the waste-risk signal.
  if (bucket.unavailable) {
    return {
      ...bucket,
      waste_risk: 'NONE',
      routing_priority: PRIORITY.EXHAUSTED,
      waste_score: 0,
    };
  }

  const { waste_risk, routing_priority, waste_score } = classifyRisk(
    bucket.capacity.used_pct,
    bucket.capacity.reset_in_seconds,
    bucket.tier_type,
  );

  return {
    ...bucket,
    waste_risk,
    routing_priority,
    waste_score,
  };
}

/**
 * Sort buckets by routing_priority ascending (1 = top), with waste_score as a
 * tie-breaker (higher waste score wins within the same priority bucket).
 */
export function sortByRoutingPriority(
  buckets: NormalizedQuotaBucket[],
): NormalizedQuotaBucket[] {
  return [...buckets].sort((a, b) => {
    if (a.routing_priority !== b.routing_priority) {
      return a.routing_priority - b.routing_priority;
    }
    return b.waste_score - a.waste_score;
  });
}

/**
 * Pick the single best bucket to route the next request to:
 *   - lowest routing_priority
 *   - skip EXHAUSTED (999)
 *   - skip metered unless nothing else is available
 *
 * Returns undefined if every bucket is exhausted.
 */
export function pickTopRecommendation(
  buckets: NormalizedQuotaBucket[],
): NormalizedQuotaBucket | undefined {
  const candidates = sortByRoutingPriority(buckets).filter(
    (b) => b.routing_priority < PRIORITY.EXHAUSTED,
  );
  return candidates[0];
}