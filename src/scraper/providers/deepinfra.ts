// =============================================================================
// DeepInfra scraper  (pay-as-you-go metered)
// =============================================================================
//   GET https://api.deepinfra.com/v1/me              → account identity
//   GET https://api.deepinfra.com/v1/me/rate_limit   → rpm / tpm limits
//   GET https://api.deepinfra.com/payment/usage?from=YYYY.MM&to=YYYY.MM
//   GET https://api.deepinfra.com/payment/checklist?compute_owed=true → balance
//       Authorization: Bearer <DEEPINFRA_API_KEY>
//
// The usage endpoint returns per-model, per-pricing-type line items:
//
//   { "months": [ { "period": "2026.09", "items": [
//       { "model": { "model_name": "moonshotai/Kimi-K3" },
//         "units": 268525, "rate": 0.000285, "cost": 77,
//         "pricing_type": "input_tokens" } ] } ] }
//
// IMPORTANT: `cost` is in **cents** (rate is cents-per-token). Verified against
// /v1/openai/models pricing: Kimi-K3 input = 2.85 USD / 1M tokens, so
// 268_525 tokens ≈ 76.5¢ and the API reports cost: 77.
//
// The checklist endpoint returns the account's Stripe balance (prepaid credit).
// A negative `stripe_balance` means available credit (e.g. -500 = $5.00 credit).
// =============================================================================

import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const USAGE_URL =
  process.env.DEEPINFRA_USAGE_URL ?? 'https://api.deepinfra.com/payment/usage';
const CHECKLIST_URL = 'https://api.deepinfra.com/payment/checklist?compute_owed=true';
const RATE_LIMIT_URL = 'https://api.deepinfra.com/v1/me/rate_limit';

interface UsageItem {
  model?: { model_name?: string } | null;
  units?: number;
  rate?: number;
  cost?: number; // cents
  pricing_type?: string;
}

interface UsageResponse {
  months?: Array<{ period: string; items?: UsageItem[] }>;
  initial_month?: string;
}

/**
 * The payment/checklist endpoint returns account billing status.
 * `stripe_balance` is in cents and negative means available credit
 * (e.g. -500 = $5.00 prepaid credit remaining).
 */
interface ChecklistResponse {
  stripe_balance?: number;
  suspended?: boolean;
  [key: string]: unknown;
}

function period(d: Date): string {
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function scrapeDeepInfra(): Promise<RawBucket[]> {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    return [
      unavailableBucket({
        model_id: 'deepinfra-spend',
        provider: 'deepinfra',
        display_name: 'DeepInfra',
        window_label: 'metered spend',
        tier_type: 'metered',
        reason: 'no DEEPINFRA_API_KEY set',
      }),
    ];
  }

  const now = new Date();
  const currentMonth = period(now);
  const prevMonth = period(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const url = `${USAGE_URL}?from=${prevMonth}&to=${currentMonth}`;

  let usage: UsageResponse;
  try {
    usage = await httpJson<UsageResponse>(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    const reason =
      err instanceof HttpError && (err.status === 401 || err.status === 403)
        ? 'DeepInfra key rejected'
        : `DeepInfra usage fetch failed — ${(err as Error).message}`;
    console.warn('[deepinfra]', reason);
    return [
      unavailableBucket({
        model_id: 'deepinfra-spend',
        provider: 'deepinfra',
        display_name: 'DeepInfra',
        window_label: 'metered spend',
        tier_type: 'metered',
        reason,
      }),
    ];
  }

  // Prefer the current month; if it has no usage yet, fall back to the most
  // recent month that does, so the card is informative early in a month.
  const monthTotals = (usage.months ?? [])
    .map((m) => ({
      period: m.period,
      cents: (m.items ?? []).reduce((sum, it) => sum + (it.cost ?? 0), 0),
      items: m.items ?? [],
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const current = monthTotals.find((m) => m.period === currentMonth);
  const chosen =
    current && current.cents > 0
      ? current
      : [...monthTotals].reverse().find((m) => m.cents > 0) ?? current ?? { period: currentMonth, cents: 0, items: [] };

  const month = chosen.period;
  const items = chosen.items;
  const spendUsd = Math.round((chosen.cents / 100) * 100) / 100;
  const isCurrent = month === currentMonth;

  // Top model by spend — handy context in the card note.
  const byModel = new Map<string, number>();
  for (const it of items) {
    const name = it.model?.model_name ?? 'unknown';
    byModel.set(name, (byModel.get(name) ?? 0) + (it.cost ?? 0));
  }
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];

  // Account balance (prepaid credit) from payment/checklist.
  let balanceUsd: number | undefined;
  try {
    const checklist = await httpJson<ChecklistResponse>(CHECKLIST_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // stripe_balance is in USD dollars (e.g. -4.94 = $4.94 available credit).
    if (typeof checklist.stripe_balance === 'number') {
      balanceUsd = checklist.stripe_balance < 0 ? Math.round(-checklist.stripe_balance * 100) / 100 : 0;
    }
  } catch {
    /* non-fatal — balance just won't be shown */
  }

  // Rate limits (informational).
  let rateNote = '';
  try {
    const rl = await httpJson<{ rate_limit?: number; tpm_rate_limit?: number }>(RATE_LIMIT_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (rl.rate_limit || rl.tpm_rate_limit) {
      rateNote = ` · ${rl.rate_limit ?? '?'} rpm / ${Math.round((rl.tpm_rate_limit ?? 0) / 1000)}k tpm`;
    }
  } catch {
    /* non-fatal */
  }

  const balanceNote = balanceUsd !== undefined ? ` · $${balanceUsd.toFixed(2)} available` : '';

  return [
    {
      model_id: 'deepinfra-spend',
      provider: 'deepinfra',
      display_name: 'DeepInfra · Metered',
      window_label: balanceUsd !== undefined ? 'balance & spend' : 'metered spend',
      tier_type: 'metered',
      capacity: {
        used_pct: 0, // not meaningful for metered — UI shows spend/balance instead
        reset_in_seconds: 0,
        spend_usd: spendUsd,
        spend_period_label: month,
        balance_usd: balanceUsd,
        limit_label: [
          balanceUsd !== undefined ? `$${balanceUsd.toFixed(2)} available` : undefined,
          isCurrent ? 'month to date' : 'last active month',
        ].filter(Boolean).join(' · '),
      },
      last_updated: new Date().toISOString(),
      notes:
        `${month}: $${spendUsd.toFixed(2)} spent` +
        (isCurrent ? ' (MTD)' : ' (last active month)') +
        balanceNote +
        (top ? ` · top: ${top[0].replace(/^.*\//, '')} ($${(top[1] / 100).toFixed(2)})` : '') +
        rateNote,
    },
  ];
}
