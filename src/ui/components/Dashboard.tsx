// =============================================================================
// Dashboard — top-level layout
// =============================================================================
// Polls /api/quota-state every 15s, groups buckets into one card per provider,
// and renders status panels that NAME the providers behind each status.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchHealth, fetchQuotaState, ApiError } from '../lib/api.js';
import type { QuotaStateResponse } from '../lib/api.js';
import { ProviderCard } from './ProviderCard.js';
import { PROVIDER_LABEL, PROVIDER_ORDER, PROVIDER_URL, modelKey } from '../../types/quota.js';
import type { NormalizedQuotaBucket, Provider, StatusGroup } from '../../types/quota.js';
import { PROVIDER_META } from '../lib/meta.js';
import {
  cardKey,
  loadCardOrder,
  loadSortMode,
  moveKey,
  saveCardOrder,
  saveSortMode,
} from '../lib/cardOrder.js';
import type { SortMode } from '../lib/cardOrder.js';

const POLL_INTERVAL_MS = 15_000;

const SORT_LABEL: Record<SortMode, string> = {
  alpha: 'A→Z',
  availability: '⚡ Best first',
  custom: '✋ Custom order',
};

const SORT_TITLE: Record<SortMode, string> = {
  alpha: 'Sorted alphabetically — click for availability order',
  availability:
    'Weekly capacity left → metered balance → unavailable — click for your custom order',
  custom: 'Your drag-and-drop order — click for alphabetical order',
};

interface State {
  data: QuotaStateResponse | null;
  loading: boolean;
  error: string | null;
  lastFetch: Date | null;
  health: { bucket_count: number; state_generated_at: string | null } | null;
}

function timeSince(d: Date | null): string {
  if (!d) return '—';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export function Dashboard() {
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const saved = loadSortMode();
    // "custom" without a stored order has nothing to say — fall back to A→Z.
    return saved === 'custom' && loadCardOrder().length === 0 ? 'alpha' : saved;
  });
  const [customOrder, setCustomOrder] = useState<string[]>(loadCardOrder);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // The source card is tracked in a ref as well as state: a drop can arrive in
  // the same task as dragstart, before React has re-rendered with the new key.
  const dragKeyRef = useRef<string | null>(null);

  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
    lastFetch: null,
    health: null,
  });

  const load = useCallback(async () => {
    try {
      const [data, health] = await Promise.all([
        fetchQuotaState(),
        fetchHealth().catch(() => null),
      ]);
      setState({
        data,
        loading: false,
        error: null,
        lastFetch: new Date(),
        health: health
          ? {
              bucket_count: health.bucket_count,
              state_generated_at: health.state_generated_at,
            }
          : null,
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setState((s) => ({ ...s, loading: false, error: msg }));
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Re-render every second so "last fetched Xs ago" stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Group flat buckets into one card per provider + account (Gemini can have
  // several Google accounts, each its own card).
  const grouped = useMemo<ProviderGroup[]>(() => {
    const buckets = state.data?.state.buckets ?? [];
    const groups = new Map<string, ProviderGroup>();
    for (const b of buckets) {
      const key = `${b.provider}\u0000${b.account ?? ''}`;
      const existing = groups.get(key);
      if (existing) existing.buckets.push(b);
      else groups.set(key, { provider: b.provider, account: b.account, buckets: [b] });
    }
    const present = [...new Set(buckets.map((b) => b.provider))];
    const rank = (p: Provider) => {
      const i = PROVIDER_ORDER.indexOf(p);
      return i === -1 ? PROVIDER_ORDER.length : i;
    };
    return [...groups.values()].sort(
      (a, b) =>
        rank(a.provider) - rank(b.provider) ||
        (a.account ?? '').localeCompare(b.account ?? ''),
    );
  }, [state.data]);

  // Apply the selected ordering to the grouped cards.
  const ordered = useMemo(
    () => sortGroups(grouped, sortMode, customOrder),
    [grouped, sortMode, customOrder],
  );

  /** Persist an order and make it the active one. */
  const commitOrder = useCallback((keys: string[]) => {
    setCustomOrder(keys);
    saveCardOrder(keys);
    setSortMode('custom');
    saveSortMode('custom');
  }, []);

  // --- drag & drop ---------------------------------------------------------
  // Only the key is custom state; positions are recomputed from what's on
  // screen, so a reorder is always "insert where I dropped it" regardless of
  // which sort mode the drag started in.
  const handleDragStart = useCallback((key: string) => {
    dragKeyRef.current = key;
    setDragKey(key);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
    setOverKey(null);
  }, []);

  const handleDragOver = useCallback(
    (key: string) => setOverKey((prev) => (prev === key ? prev : key)),
    [],
  );

  const handleDrop = useCallback(
    (targetKey: string) => {
      const sourceKey = dragKeyRef.current;
      dragKeyRef.current = null;
      setDragKey(null);
      setOverKey(null);
      if (!sourceKey || sourceKey === targetKey) return;

      const keys = ordered.map((g) => cardKey(g.provider, g.account));
      const next = moveKey(keys, sourceKey, targetKey);
      if (next) commitOrder(next);
    },
    [ordered, commitOrder],
  );

  const cycleSort = useCallback(() => {
    setSortMode((mode) => {
      const modes: SortMode[] = customOrder.length > 0
        ? ['alpha', 'availability', 'custom']
        : ['alpha', 'availability'];
      const next = modes[(modes.indexOf(mode) + 1) % modes.length];
      saveSortMode(next);
      return next;
    });
  }, [customOrder.length]);

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, import('../../types/quota.js').ProviderModels>();
    for (const pm of state.data?.state.provider_models ?? []) {
      map.set(`${pm.provider}\u0000${pm.account ?? ''}`, pm);
    }
    return map;
  }, [state.data]);

  const topId = state.data?.summary.top_recommendation?.model_id;

  if (state.loading && !state.data) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen px-6 py-8 max-w-[1500px] mx-auto">
      <Header
        source={state.data?.state.source}
        generatedAt={state.data?.state.generated_at}
        lastFetch={state.lastFetch}
        summary={state.data?.summary}
        error={state.error}
        onRefresh={load}
        loading={state.loading}
        sortMode={sortMode}
        onToggleSort={cycleSort}
      />

      {state.error && (
        <div className="mt-6 card border-red-500/40 bg-red-500/10">
          <h2 className="text-red-300 font-semibold">Couldn't reach /api/quota-state</h2>
          <p className="text-sm text-red-200/80 mt-1">{state.error}</p>
          <p className="text-sm text-zinc-400 mt-2">
            Is the scraper daemon running? Try <code className="font-mono">npm run dev</code>.
          </p>
        </div>
      )}

      {state.data && (
        <>
          {ordered.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 animate-fade-in">
              {ordered.map(({ provider, account, buckets }) => {
                const key = cardKey(provider, account);
                return (
                  <ProviderCard
                    key={key}
                    provider={provider}
                    account={account}
                    buckets={buckets}
                    models={modelsByProvider.get(`${provider}\u0000${account ?? ''}`)}
                    topRecommendationId={topId}
                    drag={{
                      dragging: dragKey === key,
                      isOver: overKey === key && dragKey !== key,
                      onDragStart: () => handleDragStart(key),
                      onDragOver: () => handleDragOver(key),
                      onDrop: () => handleDrop(key),
                      onDragEnd: handleDragEnd,
                    }}
                  />
                );
              })}
            </div>
          )}

          <Legend />
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Ordering
// -----------------------------------------------------------------------------

interface ProviderGroup {
  provider: Provider;
  account?: string;
  buckets: NormalizedQuotaBucket[];
}

type GroupTier = 'available' | 'metered' | 'unavailable';

const TIER_RANK: Record<GroupTier, number> = { available: 0, metered: 1, unavailable: 2 };

function isWeeklyBucket(b: NormalizedQuotaBucket): boolean {
  const hours = b.capacity.limit_window_hours ?? 0;
  return hours >= 24 || /week/i.test(`${b.window_label ?? ''} ${b.model_id}`);
}

/**
 * Percentage of the weekly window still unused. Falls back to the bucket with
 * the most headroom when a provider has no weekly window, so subscription
 * cards still sort sensibly.
 */
function weeklyRemainingPct(buckets: NormalizedQuotaBucket[]): number {
  const routable = buckets.filter((b) => !b.unavailable && b.tier_type !== 'metered');
  if (routable.length === 0) return Number.NEGATIVE_INFINITY;
  const weekly = routable.filter(isWeeklyBucket);
  const pool = weekly.length > 0 ? weekly : routable;
  return Math.max(...pool.map((b) => 100 - b.capacity.used_pct));
}

/** Highest prepaid balance on the card; -Infinity when none is reported. */
function balanceUsd(buckets: NormalizedQuotaBucket[]): number {
  const balances = buckets
    .map((b) => b.capacity.balance_usd)
    .filter((n): n is number => typeof n === 'number');
  return balances.length > 0 ? Math.max(...balances) : Number.NEGATIVE_INFINITY;
}

function groupTier(buckets: NormalizedQuotaBucket[]): GroupTier {
  if (buckets.some((b) => !b.unavailable && b.tier_type !== 'metered')) return 'available';
  if (buckets.some((b) => !b.unavailable)) return 'metered';
  return 'unavailable';
}

function groupLabel(group: ProviderGroup): string {
  // Match what the card header actually shows (PROVIDER_META.label), and keep
  // two Gemini accounts distinguishable.
  const label = PROVIDER_META[group.provider]?.label ?? PROVIDER_LABEL[group.provider] ?? group.provider;
  return group.account ? `${label} · ${group.account}` : label;
}

function byLabel(a: ProviderGroup, b: ProviderGroup): number {
  return (
    groupLabel(a).localeCompare(groupLabel(b)) || a.provider.localeCompare(b.provider)
  );
}

function sortGroups(
  groups: ProviderGroup[],
  mode: SortMode,
  customOrder: string[] = [],
): ProviderGroup[] {
  const list = [...groups];

  if (mode === 'custom') {
    const rank = new Map(customOrder.map((key, i) => [key, i]));
    return list.sort((a, b) => {
      const ra = rank.get(cardKey(a.provider, a.account));
      const rb = rank.get(cardKey(b.provider, b.account));
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      // Cards added since the order was saved land after it, alphabetically.
      return byLabel(a, b);
    });
  }

  if (mode === 'alpha') return list.sort(byLabel);

  return list.sort((a, b) => {
    const ta = groupTier(a.buckets);
    const tb = groupTier(b.buckets);
    if (ta !== tb) return TIER_RANK[ta] - TIER_RANK[tb];

    if (ta === 'available') {
      const ra = weeklyRemainingPct(a.buckets);
      const rb = weeklyRemainingPct(b.buckets);
      if (ra !== rb) {
        if (ra === Number.NEGATIVE_INFINITY) return 1;
        if (rb === Number.NEGATIVE_INFINITY) return -1;
        return rb - ra;
      }
    } else if (ta === 'metered') {
      const ba = balanceUsd(a.buckets);
      const bb = balanceUsd(b.buckets);
      if (ba !== bb) {
        if (ba === Number.NEGATIVE_INFINITY) return 1;
        if (bb === Number.NEGATIVE_INFINITY) return -1;
        return bb - ba;
      }
    }

    return groupLabel(a).localeCompare(groupLabel(b)) ||
      a.provider.localeCompare(b.provider);
  });
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------
function Header({
  source,
  generatedAt,
  lastFetch,
  summary,
  error,
  onRefresh,
  loading,
  sortMode,
  onToggleSort,
}: {
  source: string | undefined;
  generatedAt: string | undefined;
  lastFetch: Date | null;
  summary: QuotaStateResponse['summary'] | undefined;
  error: string | null;
  onRefresh: () => void;
  loading: boolean;
  sortMode: SortMode;
  onToggleSort: () => void;
}) {
  const availableProviders =
    summary?.providers.filter((p) => !summary.unavailable.providers.includes(p)) ?? [];

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Quota Dashboard</h1>
          {source && (
            <span
              className={`chip ${
                source === 'mock'
                  ? 'bg-zinc-700/40 text-zinc-300 border border-zinc-600/50'
                  : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
              }`}
            >
              {source === 'mock' ? '🧪 mock data' : '🟢 live'}
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-400 mt-1">
          One card per subscription · drag a card to set your own order · routes to the
          highest waste-score window first
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex flex-col items-stretch gap-1">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded-md border border-surface-700 bg-surface-800 hover:bg-surface-700 disabled:opacity-50 transition-colors"
            aria-label="Refresh now"
          >
            {loading ? '↻ …' : '↻ Refresh'}
          </button>
          <button
            onClick={onToggleSort}
            title={SORT_TITLE[sortMode]}
            aria-label={`Card order: ${SORT_TITLE[sortMode]}`}
            aria-pressed={sortMode === 'availability'}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
              sortMode === 'availability'
                ? 'border-amber-400/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'
                : 'border-surface-700 bg-surface-800 text-zinc-300 hover:bg-surface-700'
            }`}
          >
            {SORT_LABEL[sortMode]}
          </button>
        </div>
        <div className="text-xs text-zinc-500 text-right">
          <div>
            fetched: <span className="text-zinc-300 font-mono">{timeSince(lastFetch)}</span>
          </div>
          {generatedAt && (
            <div>
              state:{' '}
              <span className="text-zinc-400 font-mono">{timeSince(new Date(generatedAt))}</span>
            </div>
          )}
        </div>
      </div>

      {summary && (
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-2 mt-4">
          <StatusStat
            label="Available"
            count={availableProviders.length}
            providers={availableProviders}
            accent="text-zinc-100"
          />
          <StatusStat label="Critical" group={summary.critical} accent="text-amber-300" />
          <StatusStat label="High" group={summary.high} accent="text-orange-300" />
          <StatusStat label="Cooldown" group={summary.exhausted} accent="text-red-300" />
          <StatusStat label="Unavailable" group={summary.unavailable} accent="text-zinc-400" />
          <StatusStat label="Metered" group={summary.metered} accent="text-blue-300" />
        </div>
      )}

      {summary?.top_recommendation && (
        <div className="w-full card !p-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Next pick</span>
          <span className="text-sm font-medium text-emerald-300">
            ★ {summary.top_recommendation.display_name ?? summary.top_recommendation.model_id}
          </span>
          <span className="text-[11px] text-zinc-500">
            {PROVIDER_LABEL[summary.top_recommendation.provider] ?? summary.top_recommendation.provider}
            {summary.top_recommendation.tier_type !== 'metered' &&
              ` · ${(100 - summary.top_recommendation.capacity.used_pct).toFixed(1)}% free`}
          </span>
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {error ? `Error: ${error}` : 'State updated'}
      </span>
    </header>
  );
}

/**
 * A status panel: the count, plus the NAMES of the providers behind it.
 * `providers` can be given directly (e.g. the available-providers panel) or via `group`.
 */
function StatusStat({
  label,
  count,
  providers,
  group,
  accent,
}: {
  label: string;
  count?: number;
  providers?: Provider[];
  group?: StatusGroup;
  accent: string;
}) {
  const n = count ?? group?.count ?? 0;
  const list = providers ?? group?.providers ?? [];

  return (
    <div className="card !p-3 flex flex-col min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
        <span className={`stat-num text-lg ${accent}`}>{n}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {list.length > 0 ? (
          list.map((p) => (
            <a
              key={p}
              href={PROVIDER_URL[p]}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${PROVIDER_LABEL[p] ?? p} console in a new tab`}
              className={`chip !px-1.5 !py-0 text-[10px] ${PROVIDER_META[p]?.badge ?? ''} hover:brightness-125 focus:outline-none focus:ring-2 focus:ring-white/30 transition`}
            >
              {PROVIDER_LABEL[p] ?? p}
            </a>
          ))
        ) : (
          <span className="text-[11px] text-zinc-600">none</span>
        )}
      </div>
    </div>
  );
}

function Legend() {
  const items: { emoji: string; label: string; tone: string; desc: string }[] = [
    { emoji: '⚡', label: 'HIGH PRIORITY', tone: 'text-amber-300', desc: 'Expiring free capacity — use immediately' },
    { emoji: '🟢', label: 'ACTIVE', tone: 'text-emerald-300', desc: 'Ready to accept requests' },
    { emoji: '🔴', label: 'COOLDOWN', tone: 'text-red-300', desc: 'At max capacity — wait for reset' },
    { emoji: '🪙', label: 'METERED', tone: 'text-blue-300', desc: 'Pay-as-you-go — last-resort fallback' },
    { emoji: '⚠️', label: 'UNAVAILABLE', tone: 'text-zinc-400', desc: 'No credential / no active plan for this window' },
  ];
  return (
    <footer className="mt-10 pt-6 border-t border-surface-700/60">
      <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Status legend</h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {items.map((it) => (
          <li key={it.label} className="card !p-3 flex items-start gap-3">
            <span className="text-lg leading-none mt-0.5" aria-hidden>
              {it.emoji}
            </span>
            <div>
              <div className={`text-sm font-medium ${it.tone}`}>{it.label}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{it.desc}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-zinc-600 mt-6">
        Auto-refresh every {POLL_INTERVAL_MS / 1000}s · routed to lowest routing_priority · token
        usage read from local CLI logs (Claude Code, Codex, Kimi Code, Qwen)
      </p>
    </footer>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block w-8 h-8 border-2 border-surface-700 border-t-accent-500 rounded-full animate-spin" />
        <p className="text-sm text-zinc-500 mt-3">Loading quota state…</p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 card text-center py-16">
      <p className="text-zinc-300 font-medium">No buckets in state.</p>
      <p className="text-sm text-zinc-500 mt-1">
        Wait for the next scraper tick or run <code className="font-mono">npm run reset-state</code>.
      </p>
    </div>
  );
}
