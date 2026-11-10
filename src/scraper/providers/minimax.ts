// =============================================================================
// MiniMax scraper  (MiniMax coding / token plan)
// =============================================================================
//   GET https://api.minimax.io/v1/token_plan/remains          (intl)
//   GET https://api.minimaxi.com/v1/token_plan/remains        (CN)
//   Authorization: Bearer <MINIMAX_API_KEY>   (a coding-plan key: sk-cp-…)
//
// Response:
//   {
//     "model_remains": [{
//        "model_name": "MiniMax-M3",
//        "current_interval_total_count": 1500,
//        "current_interval_usage_count": 300,          // semantics contested!
//        "current_interval_remaining_percent": 80,     // <- authoritative: % LEFT
//        "current_weekly_remaining_percent": 42,
//        "remains_time": 1000, "weekly_remains_time": 427670466,
//        "end_time": <ms>, "weekly_end_time": <ms>
//     }],
//     "base_resp": { "status_code": 0, "status_msg": "success" }
//   }
//
// MiniMax's percent fields are "% remaining", so used% = 100 - remaining%.
// We prefer the explicit *_remaining_percent fields and only fall back to the
// count fields when they're absent.
// When there is no active plan the API returns status_code 2062 and
// model_remains: null — we surface that as an `unavailable` card.
// =============================================================================

import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const ENDPOINT =
  process.env.MINIMAX_USAGE_ENDPOINT ?? 'https://api.minimax.io/v1/token_plan/remains';

interface ModelRemain {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  current_weekly_remaining_percent?: number;
  remains_time?: number;
  weekly_remains_time?: number;
  end_time?: number;
  weekly_end_time?: number;
}

interface MiniMaxResponse {
  model_remains?: ModelRemain[] | null;
  data?: { model_remains?: ModelRemain[] | null } | null;
  base_resp?: { status_code?: number; status_msg?: string } | null;
}

/** used% from MiniMax's remaining-percent fields (preferred), else counts. */
function usedPct(o: ModelRemain, kind: 'interval' | 'weekly'): number | null {
  const remaining =
    kind === 'interval' ? o.current_interval_remaining_percent : o.current_weekly_remaining_percent;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    return Math.round(Math.max(0, Math.min(100, 100 - remaining)) * 10) / 10;
  }
  const total = o.current_interval_total_count;
  const used = o.current_interval_usage_count;
  if (typeof total === 'number' && total > 0 && typeof used === 'number') {
    return Math.round(Math.max(0, Math.min(100, (used / total) * 100)) * 10) / 10;
  }
  return null;
}

function resetFrom(ms: number | undefined, seconds: number | undefined): { seconds: number; at?: string } {
  if (typeof ms === 'number' && ms > 0) {
    return { seconds: Math.max(0, Math.round((ms - Date.now()) / 1000)), at: new Date(ms).toISOString() };
  }
  if (typeof seconds === 'number' && seconds > 0) {
    return { seconds, at: new Date(Date.now() + seconds * 1000).toISOString() };
  }
  return { seconds: 0 };
}

export async function scrapeMiniMax(): Promise<RawBucket[]> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return [
      unavailableBucket({
        model_id: 'minimax-plan',
        provider: 'minimax',
        display_name: 'MiniMax',
        window_label: 'coding plan',
        tier_type: 'rolling_window',
        reason: 'no MINIMAX_API_KEY set',
      }),
    ];
  }

  let data: MiniMaxResponse;
  try {
    data = await httpJson<MiniMaxResponse>(ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const reason =
      err instanceof HttpError && err.status === 401
        ? 'MiniMax key rejected — needs a coding-plan key (sk-cp-…)'
        : `MiniMax usage fetch failed — ${(err as Error).message}`;
    return [
      unavailableBucket({
        model_id: 'minimax-plan',
        provider: 'minimax',
        display_name: 'MiniMax',
        window_label: 'coding plan',
        tier_type: 'rolling_window',
        reason,
      }),
    ];
  }

  const status = data.base_resp?.status_code ?? 0;
  const remains = data.model_remains ?? data.data?.model_remains ?? null;

  if (status !== 0 || !remains || remains.length === 0) {
    const msg = data.base_resp?.status_msg ?? 'no active token plan subscription';
    return [
      unavailableBucket({
        model_id: 'minimax-plan',
        provider: 'minimax',
        display_name: 'MiniMax',
        window_label: 'coding plan',
        tier_type: 'rolling_window',
        reason: msg,
      }),
    ];
  }

  // Prefer the chat-model entry (highest interval total).
  const entry =
    remains.find((r) => (r.current_interval_total_count ?? 0) > 0) ?? remains[0];
  const model = entry.model_name ?? 'MiniMax';

  const buckets: RawBucket[] = [];
  const intervalUsed = usedPct(entry, 'interval');
  const weeklyUsed = usedPct(entry, 'weekly');

  if (intervalUsed !== null) {
    const r = resetFrom(entry.end_time, entry.remains_time);
    buckets.push({
      model_id: 'minimax-5h',
      provider: 'minimax',
      display_name: `MiniMax · 5-hour session`,
      window_label: '5h session',
      tier_type: 'rolling_window',
      capacity: {
        used_pct: intervalUsed,
        reset_in_seconds: r.seconds,
        limit_window_hours: 5,
        resets_at: r.at,
        limit_label: `${model} coding plan`,
      },
      last_updated: new Date().toISOString(),
      notes: model,
    });
  }

  if (weeklyUsed !== null) {
    const r = resetFrom(entry.weekly_end_time, entry.weekly_remains_time);
    buckets.push({
      model_id: 'minimax-weekly',
      provider: 'minimax',
      display_name: `MiniMax · Weekly`,
      window_label: 'Weekly',
      tier_type: 'periodic_fixed',
      capacity: {
        used_pct: weeklyUsed,
        reset_in_seconds: r.seconds,
        limit_window_hours: 168,
        resets_at: r.at,
        limit_label: `${model} coding plan`,
      },
      last_updated: new Date().toISOString(),
      notes: model,
    });
  }

  if (buckets.length === 0) {
    return [
      unavailableBucket({
        model_id: 'minimax-plan',
        provider: 'minimax',
        display_name: 'MiniMax',
        window_label: 'coding plan',
        tier_type: 'rolling_window',
        reason: 'MiniMax returned no usable usage fields',
      }),
    ];
  }

  return buckets;
}
