// =============================================================================
// Moonshot / Kimi Code scraper  (Kimi Code Plan)
// =============================================================================
//   GET https://api.kimi.com/coding/v1/usages
//   Authorization: Bearer <KIMI_API_KEY>      (a Kimi *Code* key: sk-kimi-…)
//
// Response gives both a clean normalized form and raw windows:
//
//   "usages": {
//     "limit_5h": { "used_ratio": 0.3281, "reset_time": "…Z" },
//     "limit_7d": { "used_ratio": 0.152,  "reset_time": "…Z" }
//   }
//
// The same response also carries the backup wallet used when the plan runs
// out (booster_wallet). Its balance amounts are micro-cents, i.e. 1e-8 USD
// (amount 1e9 = $10.00), NOT micro-USD — dividing by 1e6 overstates the
// wallet by 100x. The separate `monthlyUsed.priceInCents` is plain cents:
//
//   "booster_wallet": {
//     "balance": { "amount": "1000000000", "amountLeft": "465710000",
//                  "unit": "UNIT_CURRENCY" },
//     "monthlyUsed": { "currency": "USD", "priceInCents": "513" },
//     "allowTopup": true
//   }
//
// We show amountLeft as a metered backup row so the pay-as-you-go fallback is
// visible next to the plan windows.
//
// We prefer `usages` (used_ratio is already 0-1) and fall back to
// `limits[]` + `usage` (string limit/used) for older/newer shapes.
//
// NOTE: Kimi *Code* keys only work against api.kimi.com/coding/v1 — a
// platform.moonshot.ai key returns 401 here.
// =============================================================================

import type { RawBucket } from './base.js';
import { httpJson, unavailableBucket, HttpError } from './base.js';

const ENDPOINT = process.env.KIMI_USAGE_ENDPOINT ?? 'https://api.kimi.com/coding/v1/usages';

interface RatioWindow {
  used_ratio: number;
  reset_time?: string;
}

interface RawWindow {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiUsageResponse {
  usages?: {
    limit_5h?: RatioWindow;
    limit_7d?: RatioWindow;
    [key: string]: RatioWindow | undefined;
  };
  usage?: RawWindow;
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: RawWindow;
  }>;
  booster_wallet?: BoosterWallet;
}

interface Money {
  currency?: string;
  priceInCents?: string | number;
}

interface BoosterWallet {
  balance?: {
    feature?: string;
    type?: string;
    amount?: string | number;
    amountLeft?: string | number;
    unit?: string;
    periodStart?: string;
    periodEnd?: string;
  };
  status?: string;
  allowTopup?: boolean;
  topupLimit?: Money;
  monthlyUsed?: Money;
}

// 1 unit = 1e-6 cent = 1e-8 USD  →  100,000,000 units per dollar.
const WALLET_UNITS_PER_USD = 100_000_000;

function usdFromWalletUnits(v: string | number | undefined): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round((n / WALLET_UNITS_PER_USD) * 100) / 100;
}

function usdFromCents(v: string | number | undefined): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n) / 100;
}

function usd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resetSeconds(iso: string | undefined): { seconds: number; at?: string } {
  if (!iso) return { seconds: 0 };
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { seconds: 0 };
  return { seconds: Math.max(0, Math.round((ts - Date.now()) / 1000)), at: iso };
}

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function rawToPct(w: RawWindow): number {
  const limit = num(w.limit);
  const used = num(w.used);
  if (limit <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (used / limit) * 100)) * 10) / 10;
}

function ratioToPct(r: number): number {
  return Math.round(Math.max(0, Math.min(100, r * 100)) * 10) / 10;
}

function bucket(
  modelId: string,
  windowLabel: string,
  displayName: string,
  tier: 'rolling_window' | 'periodic_fixed',
  hours: number,
  usedPct: number,
  resetIso: string | undefined,
  limitLabel = 'Code Plan',
): RawBucket {
  const { seconds, at } = resetSeconds(resetIso);
  return {
    model_id: modelId,
    provider: 'moonshot',
    display_name: displayName,
    window_label: windowLabel,
    tier_type: tier,
    capacity: {
      used_pct: usedPct,
      reset_in_seconds: seconds,
      limit_window_hours: hours,
      resets_at: at,
      limit_label: limitLabel,
    },
    last_updated: new Date().toISOString(),
    notes: limitLabel,
  };
}

export async function scrapeKimi(): Promise<RawBucket[]> {
  const apiKey = process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    return [
      unavailableBucket({
        model_id: 'kimi-usage',
        provider: 'moonshot',
        display_name: 'Kimi',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason: 'no KIMI_API_KEY set',
      }),
    ];
  }

  let data: KimiUsageResponse;
  try {
    data = await httpJson<KimiUsageResponse>(ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    const reason =
      err instanceof HttpError && err.status === 401
        ? 'Kimi Code key rejected (need a Kimi Code key, sk-kimi-…)'
        : `Kimi usage fetch failed — ${(err as Error).message}`;
    console.warn('[kimi]', reason);
    return [
      unavailableBucket({
        model_id: 'kimi-usage',
        provider: 'moonshot',
        display_name: 'Kimi',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason,
      }),
    ];
  }

  const buckets: RawBucket[] = [];
  const u = data.usages;

  if (u?.limit_5h) {
    buckets.push(
      bucket('kimi-5h', '5h session', 'Moonshot · 5-hour session', 'rolling_window', 5, ratioToPct(u.limit_5h.used_ratio), u.limit_5h.reset_time, 'Code Plan'),
    );
  }
  if (u?.limit_7d) {
    buckets.push(
      bucket('kimi-weekly', 'Weekly', 'Moonshot · Weekly', 'periodic_fixed', 168, ratioToPct(u.limit_7d.used_ratio), u.limit_7d.reset_time, 'Code Plan'),
    );
  }

  // Fallback for shapes without `usages`.
  // Backup wallet: the USD balance Kimi uses after the plan allowance is spent.
  const wallet = data.booster_wallet;
  const walletBalance = wallet?.balance;
  if (
    walletBalance?.unit === 'UNIT_CURRENCY' &&
    (walletBalance.amountLeft !== undefined || walletBalance.amount !== undefined)
  ) {
    const left = usdFromWalletUnits(walletBalance.amountLeft);
    const reserved = usdFromWalletUnits(walletBalance.amount);
    const monthlyUsed = usdFromCents(wallet?.monthlyUsed?.priceInCents);

    const details = [
      reserved !== undefined ? `$${usd(reserved)} reserved` : undefined,
      monthlyUsed !== undefined ? `$${usd(monthlyUsed)} used ${currentPeriod()}` : undefined,
    ].filter(Boolean);

    if (left !== undefined) {
      buckets.push({
        model_id: 'kimi-backup',
        provider: 'moonshot',
        display_name: 'Kimi · Booster wallet (backup)',
        window_label: 'backup balance',
        tier_type: 'metered',
        capacity: {
          used_pct: 0,
          reset_in_seconds: 0,
          balance_usd: left,
          limit_label: details.join(' · '),
        },
        last_updated: new Date().toISOString(),
        notes: 'Kimi backup balance (used after the plan quota)',
      });
    }
  }

  if (buckets.length === 0) {
    const short = data.limits?.[0];
    if (short?.detail) {
      const mins = short.window?.duration ?? 300;
      buckets.push(
        bucket('kimi-5h', '5h session', 'Moonshot · 5-hour session', 'rolling_window', Math.round((mins / 60) * 10) / 10, rawToPct(short.detail), short.detail.resetTime, 'Code Plan'),
      );
    }
    if (data.usage) {
      buckets.push(
        bucket('kimi-weekly', 'Weekly', 'Moonshot · Weekly', 'periodic_fixed', 168, rawToPct(data.usage), data.usage.resetTime, 'Code Plan'),
      );
    }
  }

  if (buckets.length === 0) {
    return [
      unavailableBucket({
        model_id: 'kimi-usage',
        provider: 'moonshot',
        display_name: 'Kimi',
        window_label: 'plan windows',
        tier_type: 'rolling_window',
        reason: 'Kimi returned no usage windows for this account',
      }),
    ];
  }

  return buckets;
}
