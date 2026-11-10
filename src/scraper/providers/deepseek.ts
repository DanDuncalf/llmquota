// =============================================================================
// DeepSeek scraper  (metered pay-as-you-go)
// =============================================================================
//   GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <DEEPSEEK_API_KEY>
//
// Returns the prepaid balance. Emits a single 'metered' bucket; the calculator
// assigns priority 99 (paid fallback). On failure we emit an `unavailable`
// bucket rather than inventing a balance.
// =============================================================================

import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const ENDPOINT = process.env.DEEPSEEK_BALANCE_ENDPOINT ?? 'https://api.deepseek.com/user/balance';

interface DeepSeekBalanceResponse {
  is_available?: boolean;
  balance_infos?: Array<{
    currency: string;
    available_balance?: string;
    total_balance?: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }>;
}

function fail(reason: string): RawBucket[] {
  return [
    unavailableBucket({
      model_id: 'deepseek-balance',
      provider: 'deepseek',
      display_name: 'DeepSeek',
      window_label: 'metered balance',
      tier_type: 'metered',
      reason,
    }),
  ];
}

export async function scrapeDeepSeek(): Promise<RawBucket[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return fail('no DEEPSEEK_API_KEY set');

  let data: DeepSeekBalanceResponse;
  try {
    data = await httpJson<DeepSeekBalanceResponse>(ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    const reason =
      err instanceof HttpError && err.status === 401
        ? 'DeepSeek key rejected'
        : `DeepSeek balance fetch failed — ${(err as Error).message}`;
    console.warn('[deepseek]', reason);
    return fail(reason);
  }

  const usd = data.balance_infos?.find((b) => b.currency === 'USD') ?? data.balance_infos?.[0];
  if (!usd) return fail('DeepSeek returned no balance info');

  const balance = parseFloat(usd.available_balance ?? usd.total_balance ?? usd.topped_up_balance ?? '');
  const safe = Number.isFinite(balance) ? balance : 0;
  const cny = data.balance_infos?.find((b) => b.currency === 'CNY');
  const cnyVal = cny ? parseFloat(cny.available_balance ?? cny.total_balance ?? '') : NaN;

  return [
    {
      model_id: 'deepseek-balance',
      provider: 'deepseek',
      display_name: 'DeepSeek · Metered balance',
      window_label: 'metered balance',
      tier_type: 'metered',
      capacity: {
        used_pct: 0, // not meaningful for metered — UI shows the balance
        reset_in_seconds: 0,
        balance_usd: safe,
        limit_label: 'Pay-as-you-go · prepaid',
      },
      last_updated: new Date().toISOString(),
      notes:
        `$${safe.toFixed(2)} ${usd.currency} available` +
        (Number.isFinite(cnyVal) ? ` · ¥${cnyVal.toFixed(2)}` : '') +
        (data.is_available === false ? ' (account flagged unavailable)' : ''),
    },
  ];
}
