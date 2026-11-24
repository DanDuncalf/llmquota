// =============================================================================
// ProviderCard — one card per subscription, rendered from a card spec
// =============================================================================
// Everything provider-specific arrives in `spec` (id, label, url, palette,
// windows[]). This component never branches on a provider id: row bodies are
// chosen by the window's declared `display` primitive.
//
// Contains:
//   * one row per quota window, in the order the card declares them
//   * a token-usage table: models × (1h / 5h / 24h), when the card has one
//   * banked usage-limit resets (ChatGPT)
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import type {
  NormalizedQuotaBucket,
  ProviderModels,
  TokenTally,
  UsageResetCredit,
} from '../../types/quota.js';
import { CapacityBar } from './CapacityBar.js';
import { CountdownTimer } from './CountdownTimer.js';
import { fmtTokens, paletteOf, statusMeta } from '../lib/meta.js';
import { modelKey } from '../../types/quota.js';
import {
  displayOf,
  hostOf,
  labelOf,
  leadBucket,
  orderBuckets,
  windowFor,
} from '../lib/specs.js';
import type { CardLike } from '../lib/specs.js';

/** Expanded catalogs taller than this get their own scrollbox. */
const CATALOG_SCROLL_THRESHOLD = 9;

function formatUsd(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function tallyTitle(t: TokenTally): string {
  return [
    `input ${t.input.toLocaleString()}`,
    `output ${t.output.toLocaleString()}`,
    `cache read ${t.cache_read.toLocaleString()}`,
    `cache write ${t.cache_write.toLocaleString()}`,
    `total ${t.total.toLocaleString()}`,
    `${t.requests} records`,
  ].join('\n');
}

/** Merge banked reset credits across the card's buckets (dedupe by id), soonest first. */
function resetCreditsOf(buckets: NormalizedQuotaBucket[]): UsageResetCredit[] {
  const byId = new Map<string, UsageResetCredit>();
  for (const b of buckets) for (const c of b.reset_credits ?? []) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    const at = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
    const bt = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}

function formatRemaining(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function creditExpiry(iso: string | undefined): {
  date: string;
  remaining: string;
  urgent: boolean;
  title: string;
} {
  if (!iso) return { date: 'no expiry', remaining: '', urgent: false, title: 'No expiry reported' };
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { date: iso, remaining: '', urgent: false, title: iso };

  const when = new Date(ts);
  const sameYear = when.getFullYear() === new Date().getFullYear();
  const date = when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  });
  const secs = Math.round((ts - Date.now()) / 1000);

  return {
    date,
    remaining: secs > 0 ? `in ${formatRemaining(secs)}` : 'expired',
    urgent: secs >= 0 && secs < 3 * 86400,
    title: `Expires ${when.toLocaleString()}`,
  };
}

/** Banked usage-limit resets (ChatGPT) with their expiry dates. */
function ResetCredits({ credits }: { credits: UsageResetCredit[] }) {
  return (
    <div className="mt-3 pt-3 border-t border-surface-700/50">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Usage limit resets
        </span>
        <span className="chip bg-amber-400/10 text-amber-200 border border-amber-400/30 !px-1.5 !py-0 text-[10px]">
          <span aria-hidden>↺</span> {credits.length} available
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {credits.map((c) => {
          const exp = creditExpiry(c.expires_at);
          return (
            <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-zinc-300" title={c.description ?? c.title}>
                {c.title ?? 'Rate-limit reset'}
              </span>
              <span className="shrink-0 whitespace-nowrap" title={exp.title}>
                <span className="text-zinc-500">expires </span>
                <span className="text-zinc-300">{exp.date}</span>
                {exp.remaining && (
                  <span className={exp.urgent ? 'text-amber-300' : 'text-zinc-500'}>
                    {' '}
                    · {exp.remaining}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Row bodies — the card's `display` field picks one of these primitives.
// -----------------------------------------------------------------------------
function CurrencyBody({
  bucket,
  caption,
}: {
  bucket: NormalizedQuotaBucket;
  caption?: string;
}) {
  const { balance_usd: balance, spend_usd: spend, spend_period_label: period } = bucket.capacity;
  const hasBalance = typeof balance === 'number';
  const hasSpend = typeof spend === 'number';
  return (
    <>
      {hasBalance && hasSpend ? (
        <>
          <div className="flex items-baseline justify-between">
            <span className="stat-num text-blue-300 text-lg">{formatUsd(balance)}</span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              prepaid credits
            </span>
          </div>
          {/* Label and amount stay on one line: a lone right-aligned value
             under the balance reads as belonging to the balance above, not to
             the period it measures (DeepInfra's balance + spend window). */}
          <div className="mt-1 truncate text-[11px]" title={caption}>
            <span className="text-zinc-500">{period ? `spent ${period}` : 'spent'}</span>
            <span className="font-mono text-zinc-300"> · {formatUsd(spend)}</span>
            {caption && <span className="text-zinc-600"> · {caption}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between">
            <span className="stat-num text-blue-300 text-lg">
              {formatUsd(hasBalance ? balance : spend)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {hasBalance ? 'balance' : 'spent'}
            </span>
          </div>
          {caption && (
            <div className="mt-0.5 text-[10px] text-zinc-500 truncate" title={caption}>
              {caption}
            </div>
          )}
        </>
      )}
    </>
  );
}

function PercentBody({
  bucket,
  caption,
}: {
  bucket: NormalizedQuotaBucket;
  caption?: string;
}) {
  return (
    <>
      <CapacityBar used_pct={bucket.capacity.used_pct} />
      <div className="mt-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-zinc-300">
          <span className="stat-num text-zinc-100">{bucket.capacity.used_pct.toFixed(1)}</span>
          <span className="text-zinc-500"> % used</span>
        </span>
        <span className="text-zinc-500">
          resets{' '}
          <CountdownTimer
            reset_in_seconds={bucket.capacity.reset_in_seconds}
            resets_at={bucket.capacity.resets_at}
            className="text-zinc-300"
          />
        </span>
      </div>
      {caption && (
        <div className="mt-0.5 text-[10px] text-zinc-500 truncate" title={caption}>
          {caption}
        </div>
      )}
    </>
  );
}

function WindowRow({
  spec,
  bucket,
  isNext,
}: {
  spec: CardLike;
  bucket: NormalizedQuotaBucket;
  isNext: boolean;
}) {
  const isUnavailable = Boolean(bucket.unavailable);
  const isExhausted = bucket.routing_priority === 999 && !isUnavailable;
  const status = statusMeta(bucket.waste_risk, bucket.tier_type, isExhausted, isUnavailable);
  const display = displayOf(spec, bucket);
  const caption = bucket.capacity.limit_label ?? windowFor(spec, bucket)?.limit_label;

  return (
    <div className="py-2.5 border-t border-surface-700/50 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-200 truncate">
          {labelOf(spec, bucket)}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {isNext && (
            <span className="chip bg-amber-400/20 text-amber-200 border border-amber-400/50 !px-1.5 !py-0">
              ★ NEXT
            </span>
          )}
          <span className={`chip ${status.chip} !px-2 !py-0.5`}>
            <span aria-hidden>{status.emoji}</span>
            {status.label}
          </span>
        </div>
      </div>

      <div className="mt-2">
        {isUnavailable ? (
          <p className="text-[11px] text-zinc-500 italic">
            {bucket.unavailable_reason ?? bucket.notes ?? 'unavailable'}
          </p>
        ) : display === 'currency' ? (
          <CurrencyBody bucket={bucket} caption={caption} />
        ) : display === 'note' ? (
          <p className="text-[11px] text-zinc-400">{bucket.notes ?? caption ?? '—'}</p>
        ) : (
          <PercentBody bucket={bucket} caption={caption} />
        )}
      </div>
    </div>
  );
}

function UsageTable({ models }: { models: ProviderModels }) {
  const [showCatalog, setShowCatalog] = useState(false);

  const usedKeys = new Set(models.usage.map((u) => modelKey(u.model)));
  const noTraffic = models.catalog.filter((m) => !usedKeys.has(modelKey(m)));

  // Provider-supplied labels (e.g. "K2.8 Preview"), keyed directly and by the
  // normalized model key so prefixed log ids resolve too ("kimi-code/k3").
  const catalogLabels = models.catalog_labels ?? {};
  const labelByKey = new Map<string, string>();
  for (const [id, label] of Object.entries(catalogLabels)) labelByKey.set(modelKey(id), label);
  const labelFor = (id: string): string =>
    catalogLabels[id] ?? labelByKey.get(modelKey(id)) ?? id;

  const lastActivity = models.last_activity
    ? `${Math.max(
        0,
        Math.round((Date.now() - Date.parse(models.last_activity)) / 86400000),
      )}d ago`
    : undefined;

  return (
    <div className="mt-3 pt-3 border-t border-surface-700/50">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Token usage</span>
        <span className="text-[10px] text-zinc-600">
          {models.catalog.length} model{models.catalog.length === 1 ? '' : 's'} ·{' '}
          {models.catalog_source === 'provider_api'
            ? 'provider API'
            : models.catalog_source === 'local_config'
              ? 'local config'
              : models.catalog_source === 'mixed'
                ? 'API + observed'
                : models.catalog_source === 'observed'
                  ? 'observed'
                  : 'no catalog'}
        </span>
      </div>

      {models.usage.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-500 italic truncate" title={models.note}>
          no usage in the last 24h
          {lastActivity ? ` · logs last written ${lastActivity}` : ''}
          {models.note ? ` · ${models.note}` : ''}
        </p>
      ) : (
        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="text-left font-normal">model</th>
              <th className="text-right font-normal w-12">1h</th>
              <th className="text-right font-normal w-12">5h</th>
              <th className="text-right font-normal w-14">24h</th>
            </tr>
          </thead>
          <tbody>
            {models.usage.map((u) => (
              <tr key={u.model} className="border-t border-surface-700/40">
                <td className="py-1 pr-2 text-zinc-300 truncate max-w-[9rem]" title={u.model}>
                  {labelFor(u.model)}
                </td>
                <td
                  className="py-1 text-right font-mono text-zinc-400"
                  title={tallyTitle(u.windows.h1)}
                >
                  {fmtTokens(u.windows.h1.total)}
                </td>
                <td
                  className="py-1 text-right font-mono text-zinc-300"
                  title={tallyTitle(u.windows.h5)}
                >
                  {fmtTokens(u.windows.h5.total)}
                </td>
                <td
                  className="py-1 text-right font-mono text-zinc-200"
                  title={tallyTitle(u.windows.h24)}
                >
                  {fmtTokens(u.windows.h24.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {models.monthly && (
        <div className="mt-2 text-[11px] text-zinc-400">
          <span className="text-zinc-500">monthly {models.monthly.period}: </span>
          <span className="font-mono text-zinc-200">{fmtTokens(models.monthly.total_tokens)}</span>
          <span className="text-zinc-500">
            {' '}
            ·{' '}
            {models.monthly.models
              .slice(0, 2)
              .map((m) => `${m.model.replace(/^.*\//, '')} ${fmtTokens(m.tokens)}`)
              .join(', ')}
          </span>
        </div>
      )}

      {models.catalog.length > 0 && (
        <>
          <button
            onClick={() => setShowCatalog((v) => !v)}
            className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showCatalog ? '▾' : '▸'} {showCatalog ? 'Hide' : 'Show'} all {models.catalog.length}{' '}
            models
            {noTraffic.length > 0 && ` (${noTraffic.length} no traffic)`}
          </button>
          {showCatalog && (
            <div
              className={`mt-1.5 flex flex-wrap gap-1 ${
                models.catalog.length > CATALOG_SCROLL_THRESHOLD
                  ? 'max-h-40 overflow-y-auto pr-1'
                  : ''
              }`}
              data-no-drag
            >
              {models.catalog.map((m) => {
                const label = catalogLabels[m];
                const used = usedKeys.has(modelKey(m));
                return (
                  <span
                    key={m}
                    className={`chip !px-1.5 !py-0 text-[10px] ${
                      used
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                        : 'bg-zinc-700/30 text-zinc-400 border border-zinc-600/40'
                    }`}
                    title={
                      label
                        ? `${label} · ${m} · ${used ? 'used in the last 24h' : 'no traffic in the last 24h'}`
                        : used
                          ? 'used in the last 24h'
                          : 'no traffic in the last 24h'
                    }
                  >
                    {label ?? m}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}

      {models.usage.length > 0 && models.note && (
        <p className="mt-2 text-[10px] text-zinc-600">{models.note}</p>
      )}
    </div>
  );
}

interface DragProps {
  dragging: boolean;
  isOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/** Actions offered by the card's hamburger menu. All callbacks are fire-and-
 *  forget: the parent owns the async work and reloads the dashboard. */
export interface CardMenuProps {
  busy: boolean;
  onRefresh: () => void;
  onHide: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** "☰" dropdown pinned to the card header. Closes on outside pointer-down. */
function CardMenu({ busy, onRefresh, onHide, onEdit, onDelete }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const itemCls =
    'block w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-surface-700 hover:text-zinc-100 transition-colors disabled:opacity-40';
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Card actions"
        title="Card actions"
        className="px-1.5 py-0.5 text-sm leading-none rounded border border-surface-700 text-zinc-500 hover:text-zinc-200 hover:bg-surface-700 transition-colors disabled:opacity-40"
      >
        {busy ? '…' : '☰'}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[8.5rem] rounded-md border border-surface-600 bg-surface-800 shadow-lg shadow-black/40 py-1"
        >
          <button role="menuitem" className={itemCls} disabled={busy} onClick={run(onRefresh)}>
            ↻ Refresh
          </button>
          <button role="menuitem" className={itemCls} disabled={busy} onClick={run(onHide)}>
            Hide
          </button>
          <button role="menuitem" className={itemCls} disabled={busy} onClick={run(onEdit)}>
            Edit
          </button>
          <button
            role="menuitem"
            className={`${itemCls} text-red-300 hover:text-red-200 hover:bg-red-500/10`}
            disabled={busy}
            onClick={run(onDelete)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  spec: CardLike;
  account?: string;
  buckets: NormalizedQuotaBucket[];
  models?: ProviderModels;
  topRecommendationId: string | undefined;
  /** "waiting for the scraper" hint when the card has no measurements yet. */
  pending?: boolean;
  drag?: DragProps;
  /** Hamburger actions (refresh / hide / edit / delete). */
  menu?: CardMenuProps;
}

export function ProviderCard({
  spec,
  account,
  buckets,
  models,
  topRecommendationId,
  pending,
  drag,
  menu,
}: Props) {
  const palette = paletteOf(spec.palette);
  const lead = leadBucket(spec, buckets);
  const resetCredits = resetCreditsOf(buckets);
  const anyNext = buckets.some((b) => b.model_id === topRecommendationId);
  const host = hostOf(spec.url);

  // The whole card is draggable, but a drag that starts on a link, button or
  // the inner scrollbox must keep its native behaviour (click / scroll).
  const dragArmed = useRef(false);

  const leadStatus = lead
    ? statusMeta(
        lead.waste_risk,
        lead.tier_type,
        lead.routing_priority === 999 && !lead.unavailable,
        Boolean(lead.unavailable),
      )
    : null;

  const cardTop = anyNext ? 'card-top ring-2 ring-amber-400/70' : '';
  const accentBar = `before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 ${
    leadStatus?.accent ?? 'before:bg-zinc-600'
  }`;
  const dragState = drag
    ? drag.dragging
      ? 'opacity-40'
      : drag.isOver
        ? 'ring-2 ring-emerald-400/70'
        : ''
    : '';

  return (
    <article
      draggable={Boolean(drag)}
      onPointerDown={
        drag
          ? (e) => {
              const el = e.target as HTMLElement;
              // A scroll box that actually overflows keeps its native scroll
              // gesture; one that fits (most cards) still drags from anywhere.
              const scroller = el.closest<HTMLElement>('[data-no-drag]');
              const scrolling = Boolean(
                scroller && scroller.scrollHeight > scroller.clientHeight + 1,
              );
              dragArmed.current =
                !scrolling && !el.closest('a, button, input, select, textarea');
            }
          : undefined
      }
      onDragStart={
        drag
          ? (e) => {
              if (!dragArmed.current) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.effectAllowed = 'move';
              // Some browsers refuse to start a drag without payload data.
              e.dataTransfer.setData('text/plain', `${spec.id}:${account ?? ''}`);
              drag.onDragStart();
            }
          : undefined
      }
      onDragEnd={
        drag
          ? () => {
              dragArmed.current = false;
              drag.onDragEnd();
            }
          : undefined
      }
      onDragOver={
        drag
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              drag.onDragOver();
            }
          : undefined
      }
      onDrop={
        drag
          ? (e) => {
              e.preventDefault();
              drag.onDrop();
            }
          : undefined
      }
      className={`card relative overflow-hidden ${cardTop} ${accentBar} ${dragState} ${
        drag ? 'cursor-grab active:cursor-grabbing' : ''
      } before:content-[''] transition-[box-shadow,opacity]`}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {drag && (
            <span
              aria-hidden
              title="Drag to reorder the cards"
              className="shrink-0 text-zinc-600 hover:text-zinc-300 select-none leading-none text-sm tracking-tighter"
            >
              ⠿
            </span>
          )}
          {spec.url ? (
            <a
              href={spec.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${spec.label} — ${host}`}
              aria-label={`Open ${spec.label} console in a new tab (${host})`}
              className={`chip ${palette.badge} hover:brightness-125 focus:outline-none focus:ring-2 focus:ring-white/30 transition`}
            >
              {spec.label}
              <span aria-hidden className="ml-1 opacity-60">
                ↗
              </span>
            </a>
          ) : (
            <span className={`chip ${palette.badge}`} title={spec.notes}>
              {spec.label}
            </span>
          )}
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {buckets.length} window{buckets.length === 1 ? '' : 's'}
          </span>
        </div>
        {leadStatus && (
          <span className={`chip ${leadStatus.chip} shrink-0`} title={leadStatus.description}>
            <span aria-hidden>{leadStatus.emoji}</span>
            {leadStatus.label}
          </span>
        )}
        {menu && <CardMenu {...menu} />}
      </header>

      {account && (
        <div className="mt-1 text-[10px] text-zinc-400 truncate" title={account}>
          {account}
        </div>
      )}

      <div className="mt-3 max-h-64 overflow-y-auto overscroll-contain pr-1" data-no-drag>
        {buckets.length === 0 ? (
          <p className="text-[11px] text-zinc-500 italic">
            {pending
              ? 'waiting for the scraper to report this card…'
              : 'no windows reported'}
          </p>
        ) : (
          orderBuckets(spec, buckets).map((b) => (
            <WindowRow
              key={b.model_id}
              spec={spec}
              bucket={b}
              isNext={b.model_id === topRecommendationId}
            />
          ))
        )}
      </div>

      {resetCredits.length > 0 && <ResetCredits credits={resetCredits} />}

      {models && <UsageTable models={models} />}

      <footer className="mt-3 pt-2 border-t border-surface-700/50 flex items-center justify-between text-[10px]">
        <span className="text-zinc-600 truncate" title={spec.notes}>
          {host || spec.company || spec.id}
        </span>
        {spec.url ? (
          <a
            href={spec.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-400 hover:text-zinc-100 transition-colors shrink-0"
          >
            open console ↗
          </a>
        ) : (
          <span className="text-zinc-700 shrink-0">no console url</span>
        )}
      </footer>
    </article>
  );
}
