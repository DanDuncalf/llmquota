// =============================================================================
// Plain-text renderer for the Quota Dashboard
// =============================================================================
// Three sections:
//   1. header + status summary (each status lists the providers behind it)
//   2. quota windows, grouped one block per provider
//   3. token usage per model over 1h / 5h / 24h
//
// ASCII grid (plus optional ANSI color) so it survives cmd.exe, PowerShell,
// git-bash, and `| less`.
//
//   curl -s http://127.0.0.1:8787/            # grouped table
//   curl -s 'http://127.0.0.1:8787/?color=1'  # with ANSI color
// =============================================================================

import { pickTopRecommendation } from '../scraper/calculator.js';
import { PROVIDER_LABEL, PROVIDER_ORDER, PROVIDER_URL, modelKey } from '../types/quota.js';
import type {
  NormalizedQuotaBucket,
  Provider,
  ProviderModels,
  QuotaStateFile,
  StatusGroup,
  UsageResetCredit,
} from '../types/quota.js';

const ROW = { window: 16, risk: 11, used: 7, bar: 12, reset: 9 };

const ANSI_RESET = '\x1b[0m';
const RISK_COLOR: Record<NormalizedQuotaBucket['waste_risk'], string> = {
  CRITICAL: '\x1b[1;91m',
  HIGH: '\x1b[1;33m',
  MODERATE: '\x1b[1;32m',
  LOW: '\x1b[1;34m',
  NONE: '\x1b[1;90m',
};

const WIDTH = 94;

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const chars = [...value];
  const s = chars.length > width ? `${chars.slice(0, width - 1).join('')}…` : value;
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function formatAge(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'unknown';
  return `${formatDuration(Math.max(0, Math.round((Date.now() - ts) / 1000)))} ago`;
}

/** "2026-10-22" for an ISO timestamp, or "—". */
function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toISOString().slice(0, 10);
}

/** "in 3d 2h" / "expired" for an ISO timestamp. */
function formatUntil(iso: string | undefined): string {
  if (!iso) return 'no expiry';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const seconds = Math.round((ts - Date.now()) / 1000);
  return seconds > 0 ? `in ${formatDuration(seconds)}` : 'expired';
}

/** Banked resets, deduped across buckets and sorted by expiry. */
function resetCreditsOf(buckets: NormalizedQuotaBucket[]): UsageResetCredit[] {
  const byId = new Map<string, UsageResetCredit>();
  for (const b of buckets) for (const c of b.reset_credits ?? []) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    const at = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
    const bt = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}

/** Compact token counts: 1234 → 1.2k, 1_234_567 → 1.23M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function capacityBar(usedPct: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, usedPct));
  const filled = Math.round((clamped / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function statusLabel(b: NormalizedQuotaBucket): string {
  if (b.unavailable) return 'UNAVAILABLE';
  if (b.routing_priority === 999) return 'COOLDOWN';
  if (b.tier_type === 'metered') return 'METERED';
  return b.waste_risk;
}

function meteredValue(b: NormalizedQuotaBucket): string {
  const suffix =
    b.model_id === 'kimi-backup' && b.capacity.limit_label
      ? ` · ${b.capacity.limit_label}`
      : '';
  if (typeof b.capacity.balance_usd === 'number' && typeof b.capacity.spend_usd === 'number') {
    const period = b.capacity.spend_period_label ? ` (${b.capacity.spend_period_label})` : '';
    return `$${b.capacity.balance_usd.toFixed(2)} available · $${b.capacity.spend_usd.toFixed(2)} spent${period}${suffix}`;
  }
  if (typeof b.capacity.balance_usd === 'number') return `$${b.capacity.balance_usd.toFixed(2)} balance${suffix}`;
  if (typeof b.capacity.spend_usd === 'number') {
    const period = b.capacity.spend_period_label ? ` (${b.capacity.spend_period_label})` : '';
    return `$${b.capacity.spend_usd.toFixed(2)} spent${period}`;
  }
  return '—';
}

function rowFor(b: NormalizedQuotaBucket, isNext: boolean, color: boolean): string {
  const label = pad(b.window_label ?? b.display_name ?? b.model_id, ROW.window);
  const nextTag = isNext ? '  <== NEXT' : '';

  if (b.unavailable) {
    return `  ${label}  ${pad('UNAVAILABLE', ROW.risk)}  ${b.unavailable_reason ?? 'unavailable'}${nextTag}`;
  }

  const statusCell = pad(statusLabel(b), ROW.risk);
  const painted = color ? `${RISK_COLOR[b.waste_risk]}${statusCell}${ANSI_RESET}` : statusCell;

  if (b.tier_type === 'metered') {
    return `  ${label}  ${painted}  ${meteredValue(b)}${nextTag}`;
  }

  const used = pad(`${b.capacity.used_pct.toFixed(1)}%`, ROW.used, 'right');
  const bar = capacityBar(b.capacity.used_pct);
  const reset = pad(formatDuration(b.capacity.reset_in_seconds), ROW.reset, 'right');
  return `  ${label}  ${painted}  ${used} ${bar} ${reset}  ${b.capacity.limit_label ?? ''}${nextTag}`;
}

/** "Kimi, ChatGPT" or "—". */
function providerNames(sg: StatusGroup): string {
  if (sg.providers.length === 0) return '—';
  return sg.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(', ');
}

function providerOrder(state: QuotaStateFile): Provider[] {
  const present = new Set<Provider>([
    ...state.buckets.map((b) => b.provider),
    ...(state.provider_models ?? []).map((m) => m.provider),
  ]);
  return [
    ...PROVIDER_ORDER.filter((p) => present.has(p)),
    ...[...present].filter((p) => !PROVIDER_ORDER.includes(p)),
  ];
}

function usageSection(pm: ProviderModels): string[] {
  const out: string[] = [];
  const label = PROVIDER_LABEL[pm.provider] ?? pm.provider;
  const srcLabel =
    pm.catalog_source === 'provider_api'
      ? 'from provider API'
      : pm.catalog_source === 'local_config'
        ? 'from local CLI config'
        : pm.catalog_source === 'mixed'
          ? 'provider API + observed'
          : pm.catalog_source === 'observed'
            ? 'observed in local logs'
            : 'catalog unavailable';

  out.push('');
  out.push(`${label.toUpperCase()}  (${pm.catalog.length} model${pm.catalog.length === 1 ? '' : 's'} · ${srcLabel})`);

  if (pm.usage.length === 0) {
    const last = pm.last_activity
      ? `logs last written ${pm.last_activity.slice(0, 10)}`
      : undefined;
    out.push(
      `  ${['no usage in the last 24h', last, pm.note].filter(Boolean).join(' · ')}`,
    );
  } else {
    out.push(`  ${pad('model', 26)} ${pad('1h', 10, 'right')} ${pad('5h', 10, 'right')} ${pad('24h', 11, 'right')}  reqs(24h)`);
    for (const u of pm.usage) {
      out.push(
        `  ${pad(u.model, 26)} ${pad(fmtTokens(u.windows.h1.total), 10, 'right')} ` +
          `${pad(fmtTokens(u.windows.h5.total), 10, 'right')} ${pad(fmtTokens(u.windows.h24.total), 11, 'right')}  ` +
          `${u.windows.h24.requests}`,
      );
    }
    // Models in the catalog that saw no traffic — summarised, not listed.
    const usedKeys = new Set(pm.usage.map((u) => modelKey(u.model)));
    const unusedCatalog = pm.catalog.filter((c) => !usedKeys.has(modelKey(c)));
    if (unusedCatalog.length > 0) {
      out.push(`  (+${unusedCatalog.length} catalog model${unusedCatalog.length === 1 ? '' : 's'} with no traffic: ${unusedCatalog.slice(0, 4).join(', ')}${unusedCatalog.length > 4 ? ', …' : ''})`);
    }
  }

  if (pm.monthly) {
    out.push(
      `  monthly (${pm.monthly.period}): ${fmtTokens(pm.monthly.total_tokens)} tokens · ` +
        `${pm.monthly.models.map((m) => `${m.model.replace(/^.*\//, '')} ${fmtTokens(m.tokens)}`).slice(0, 4).join(', ')}`,
    );
  }
  if (pm.usage.length > 0 && pm.note) out.push(`  note: ${pm.note}`);
  return out;
}

export function renderQuotaText(state: QuotaStateFile, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? false;
  const top = pickTopRecommendation(state.buckets);
  const buckets = state.buckets;

  const isCrit = (b: NormalizedQuotaBucket) => !b.unavailable && b.waste_risk === 'CRITICAL';
  const isHigh = (b: NormalizedQuotaBucket) => !b.unavailable && b.waste_risk === 'HIGH';
  const isCooldown = (b: NormalizedQuotaBucket) => !b.unavailable && b.routing_priority === 999;
  const isMetered = (b: NormalizedQuotaBucket) => !b.unavailable && b.tier_type === 'metered';
  const isUnavail = (b: NormalizedQuotaBucket) => Boolean(b.unavailable);

  const providersOf = (pred: (b: NormalizedQuotaBucket) => boolean) =>
    [...new Set(buckets.filter(pred).map((b) => b.provider))];

  const rule = '='.repeat(WIDTH);
  const order = providerOrder(state);
  const lines: string[] = [];

  lines.push('QUOTA DASHBOARD  ·  Multi-LLM Fleet');
  lines.push(rule);
  lines.push(
    `source: ${state.source}    generated: ${state.generated_at} (${formatAge(state.generated_at)})    ` +
      `providers: ${order.length}    windows: ${buckets.length}`,
  );
  lines.push('');
  lines.push(`PROVIDERS    ${providerNames({ count: order.length, providers: order })}`);
  lines.push(`CRITICAL     ${providerNames({ count: 0, providers: providersOf(isCrit) })}`);
  lines.push(`HIGH         ${providerNames({ count: 0, providers: providersOf(isHigh) })}`);
  lines.push(`COOLDOWN     ${providerNames({ count: 0, providers: providersOf(isCooldown) })}`);
  lines.push(`METERED      ${providerNames({ count: 0, providers: providersOf(isMetered) })}`);
  lines.push(`UNAVAILABLE  ${providerNames({ count: 0, providers: providersOf(isUnavail) })}`);

  // ---- Quota windows -------------------------------------------------------
  lines.push('');
  lines.push('-- quota windows ' + '-'.repeat(WIDTH - 18));
  for (const provider of order) {
    const providerRows = buckets.filter((b) => b.provider === provider);
    if (providerRows.length === 0) continue;
    const accounts = [...new Set(providerRows.map((b) => b.account ?? ''))];

    for (const account of accounts) {
      const rows = providerRows.filter((b) => (b.account ?? '') === account).sort((a, b) => {
        const am = a.tier_type === 'metered' ? 1 : 0;
        const bm = b.tier_type === 'metered' ? 1 : 0;
        if (am !== bm) return am - bm;
        const ah = a.capacity.limit_window_hours ?? 999;
        const bh = b.capacity.limit_window_hours ?? 999;
        if (ah !== bh) return ah - bh;
        return b.capacity.used_pct - a.capacity.used_pct;
      });
      const anyNext = rows.some((r) => r.model_id === top?.model_id);
      const names = providerNames({ count: 0, providers: [provider] });
      const accountTag = account ? ` · ${account}` : '';
      lines.push('');
      lines.push(`${names.toUpperCase()}${accountTag}  (${provider})${anyNext ? '   * has next pick' : ''}`);
      lines.push(`  ${PROVIDER_URL[provider]}`);
      for (const b of rows) lines.push(rowFor(b, b.model_id === top?.model_id, color));

      const credits = resetCreditsOf(rows);
      if (credits.length > 0) {
        lines.push(`  usage-limit resets: ${credits.length} available`);
        for (const c of credits) {
          lines.push(
            `    ${pad(c.title ?? 'Rate-limit reset', 30)} expires ${formatDate(c.expires_at)} (${formatUntil(c.expires_at)})`,
          );
        }
      }
    }
  }

  // ---- Usage ---------------------------------------------------------------
  lines.push('');
  lines.push('-- token usage per model (rolling 1h / 5h / 24h) ' + '-'.repeat(WIDTH - 48));
  for (const pm of state.provider_models ?? []) {
    lines.push(...usageSection(pm));
  }

  lines.push('');
  lines.push(rule);
  lines.push(
    `summary: ${buckets.length} windows · ${buckets.filter(isCrit).length} critical · ` +
      `${buckets.filter(isHigh).length} high · ${buckets.filter(isCooldown).length} cooldown · ` +
      `${buckets.filter(isUnavail).length} unavailable · ${buckets.filter(isMetered).length} metered`,
  );

  if (top) {
    const detail =
      top.tier_type === 'metered'
        ? meteredValue(top)
        : `${(100 - top.capacity.used_pct).toFixed(1)}% free, resets in ${formatDuration(top.capacity.reset_in_seconds)}`;
    lines.push(`next   : -> ${top.display_name ?? top.model_id} (${top.provider}) — ${statusLabel(top)}, ${detail}`);
  } else {
    lines.push('next   : no routable window — everything is exhausted or unavailable');
  }

  lines.push('');
  lines.push('(JSON: /api/quota-state   ·   text: /api/quota-state?format=text or /   ·   color: add &color=1)');

  return lines.join('\n') + '\n';
}

/** True when the client wants text instead of JSON. */
export function wantsText(req: {
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
}): boolean {
  const fmt = String(req.query.format ?? '').toLowerCase();
  if (fmt === 'text' || fmt === 'txt' || fmt === 'plain') return true;
  if (fmt === 'json') return false;
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/plain') && !accept.includes('application/json');
}

export function wantsColor(req: { query: Record<string, unknown> }): boolean {
  const c = String(req.query.color ?? '').toLowerCase();
  return c === '1' || c === 'true' || c === 'yes';
}
