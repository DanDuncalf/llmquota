// =============================================================================
// DeepSeek platform usage
// =============================================================================
// The public DeepSeek API only exposes /user/balance. Detailed token counts
// live behind the platform dashboard endpoints, authenticated with the browser
// session token (DEEPSEEK_PLATFORM_TOKEN) — NOT the sk- API key.
//
//   GET https://platform.deepseek.com/api/v0/usage/amount?month=MM&year=YYYY
//   GET https://platform.deepseek.com/api/v0/usage/cost?month=MM&year=YYYY
//   Authorization: Bearer <platform token>
//   x-client-platform: web
//
// The by-api-key series endpoints return INVALID_PARAM for this account, so we
// use the monthly response, which also carries per-day, per-model buckets. The
// dashboard's 24h column therefore means "today so far" (local calendar day),
// not a rolling 24-hour window; 1h/5h are unknown at this granularity.
// =============================================================================

import type { ModelRollup } from './local-usage.js';
import { emptyTally } from './local-usage.js';
import { httpJson } from '../providers/base.js';

interface UsageItem {
  type?: string;
  amount?: string | number;
}

interface ModelUsage {
  model?: string;
  usage?: UsageItem[];
}

interface DayUsage {
  date?: string;
  data?: ModelUsage[];
}

interface AmountBizData {
  total?: ModelUsage[];
  days?: DayUsage[];
}

interface PlatformEnvelope<T> {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: T;
  };
}

export interface DeepSeekPlatformUsage {
  /** Today's per-model tallies, shaped like the local-log rollups. */
  rollups: ModelRollup[];
  today: string;
  /** Set when the platform call failed (expired token, endpoint change, …). */
  error?: string;
}

const PLATFORM = 'https://platform.deepseek.com/api/v0';

function platformToken(): string | undefined {
  const token = process.env.DEEPSEEK_PLATFORM_TOKEN?.trim();
  return token ? token : undefined;
}

function num(value: string | number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** YYYY-MM-DD in local time — the platform buckets use the account's day. */
function dayKey(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function tallyFor(items: UsageItem[]): { input: number; output: number; cacheRead: number; requests: number; total: number } {
  let cacheHit = 0;
  let cacheMiss = 0;
  let prompt = 0;
  let output = 0;
  let requests = 0;

  for (const item of items) {
    const amount = num(item.amount);
    switch (item.type) {
      case 'PROMPT_CACHE_HIT_TOKEN':
        cacheHit += amount;
        break;
      case 'PROMPT_CACHE_MISS_TOKEN':
        cacheMiss += amount;
        break;
      case 'PROMPT_TOKEN':
        prompt += amount;
        break;
      case 'RESPONSE_TOKEN':
        output += amount;
        break;
      case 'REQUEST':
        requests += amount;
        break;
    }
  }

  // Prefer the cache hit/miss split; fall back to the aggregate prompt count.
  const input = cacheMiss > 0 || cacheHit > 0 ? cacheMiss : prompt;
  const total = input + cacheHit + output;
  return { input, output, cacheRead: cacheHit, requests, total };
}

export async function fetchDeepSeekPlatformUsage(
  now: Date = new Date(),
): Promise<DeepSeekPlatformUsage | null> {
  const token = platformToken();
  if (!token) return null; // feature not configured — leave the card balance-only

  const today = dayKey(now);
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const url = `${PLATFORM}/usage/amount?month=${month}&year=${year}`;

  try {
    const payload = await httpJson<PlatformEnvelope<AmountBizData>>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'x-client-platform': 'web',
      },
    });

    const code = payload.code ?? 0;
    const bizCode = payload.data?.biz_code ?? 0;
    if (code !== 0) {
      const message = payload.msg || `platform code ${code}`;
      return { rollups: [], today, error: `DeepSeek platform usage: ${message}` };
    }
    if (bizCode !== 0) {
      const message = payload.data?.biz_msg || `biz_code ${bizCode}`;
      const auth = bizCode === 40002 || bizCode === 40003;
      return {
        rollups: [],
        today,
        error: auth
          ? 'DeepSeek platform token expired — re-import it from platform.deepseek.com'
          : `DeepSeek platform usage: ${message}`,
      };
    }

    const day = (payload.data?.biz_data?.days ?? []).find((d) => d.date === today);
    if (!day) return { rollups: [], today };

    const rollups: ModelRollup[] = [];
    for (const entry of day.data ?? []) {
      if (!entry.model) continue;
      const t = tallyFor(entry.usage ?? []);
      if (t.total <= 0) continue;

      const tally = emptyTally();
      tally.input = t.input;
      tally.output = t.output;
      tally.cache_read = t.cacheRead;
      tally.cache_write = 0;
      tally.total = t.total;
      tally.requests = t.requests;

      rollups.push({
        provider: 'deepseek',
        model: entry.model,
        h1: emptyTally(),
        h5: emptyTally(),
        h24: tally,
        lastSeen: now.getTime(),
      });
    }

    rollups.sort((a, b) => b.h24.total - a.h24.total);
    return { rollups, today };
  } catch (err) {
    return {
      rollups: [],
      today,
      error: `DeepSeek platform usage unavailable — ${(err as Error).message}`,
    };
  }
}
