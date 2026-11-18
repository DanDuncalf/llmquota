// =============================================================================
// CardList — list / add / edit / remove card specifications
// =============================================================================
// Cards are JSON files on disk. This view is a thin manager over
// GET/PUT/DELETE /api/cards (server-side zod validation in src/cards/spec.ts).
//
// Two things are shown besides the cards themselves:
//   * load errors — files that failed to parse, with their path
//   * orphan providers — buckets in state.json with no card, which still render
//     generically but cannot carry identity, palette or console link
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { NormalizedQuotaBucket } from '../../types/quota.js';
import type { ApiError, CardLoadError, LoadedCard } from '../lib/api.js';
import { deleteCard, saveCard } from '../lib/api.js';
import { paletteOf } from '../lib/meta.js';
import { CardEditor } from './CardEditor.js';

type Editing = { isNew: boolean; card?: LoadedCard; presetId?: string } | null;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function CardList({
  cards,
  errors,
  bucketsByProvider,
  editRequest,
  onChanged,
}: {
  cards: LoadedCard[];
  errors: CardLoadError[];
  bucketsByProvider: Map<string, NormalizedQuotaBucket[]>;
  /** Open this card in the editor (from the dashboard card menu). */
  editRequest?: { id: string; n: number } | null;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // A dashboard card menu "Edit" asks to open this view with a card loaded.
  const requestedId = editRequest?.id ?? null;
  const requestNonce = editRequest?.n ?? 0;
  useEffect(() => {
    if (!requestedId) return;
    const card = cards.find((c) => c.id === requestedId);
    if (card) {
      setProblems([]);
      setNotice(null);
      setEditing({ isNew: false, card });
    }
  }, [requestedId, requestNonce, cards]);

  const reset = (): void => {
    setEditing(null);
    setProblems([]);
  };

  const handleSave = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      setProblems([]);
      try {
        const result = await saveCard(String(payload.id ?? ''), payload);
        setNotice(`saved ${result.card.id} → ${result.card.source_path}`);
        setEditing(null);
        await onChanged();
      } catch (err) {
        const details = (err as ApiError).details;
        setProblems(details && details.length > 0 ? details : [messageOf(err)]);
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const remove = useCallback(
    async (card: LoadedCard) => {
      const ok = window.confirm(
        `Delete card "${card.label}"?\n\nThis removes ${card.source_path}.\n` +
          'Its buckets will keep rendering generically until the next scrape removes them.',
      );
      if (!ok) return;
      setBusy(true);
      setProblems([]);
      try {
        await deleteCard(card.id);
        setNotice(`deleted ${card.id}`);
        setEditing(null);
        await onChanged();
      } catch (err) {
        const details = (err as ApiError).details;
        setProblems(details && details.length > 0 ? details : [messageOf(err)]);
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  /** Flip a template card between hidden and shown. Hidden cards stay off the dashboard. */
  const toggleShown = useCallback(
    async (card: LoadedCard) => {
      setBusy(true);
      setProblems([]);
      try {
        await saveCard(card.id, { ...card, shown: !card.shown });
        setNotice(`${card.shown ? 'hid' : 'showed'} ${card.id}`);
        await onChanged();
      } catch (err) {
        const details = (err as ApiError).details;
        setProblems(details && details.length > 0 ? details : [messageOf(err)]);
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const orphanIds = [...bucketsByProvider.keys()].filter(
    (id) => !cards.some((c) => c.id === id),
  );

  const withData = cards.filter((c) => bucketsByProvider.has(c.id)).length;
  const shownCount = cards.filter((c) => c.shown).length;

  const q = filter.trim().toLowerCase();
  const visible = q
    ? cards.filter((c) =>
        [c.id, c.label, c.company ?? '', ...c.aliases].some((v) =>
          v.toLowerCase().includes(q),
        ),
      )
    : cards;

  return (
    <section className="mt-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Cards</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {cards.length} card{cards.length === 1 ? '' : 's'} · {shownCount} shown ·{' '}
            {withData} with data · {cards.length - withData} waiting · {errors.length} load error
            {errors.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by id, label, company or alias…"
            aria-label="Filter cards"
            className="w-64 bg-surface-900 border border-surface-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
          <button
            onClick={() => {
              setProblems([]);
              setNotice(null);
              setEditing({ isNew: true });
            }}
            className="px-3 py-1.5 text-xs rounded-md bg-accent-500 hover:bg-accent-600 text-white transition-colors shrink-0"
          >
            + New card
          </button>
        </div>
      </div>

      {notice && (
        <p className="mt-3 text-[11px] text-emerald-300/90 font-mono truncate" title={notice}>
          {notice}
        </p>
      )}

      {(errors.length > 0 || problems.length > 0) && (
        <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-[11px] uppercase tracking-wider text-red-300">Card errors</p>
          <ul className="mt-1 space-y-1 text-[11px] text-red-200/90">
            {errors.map((e) => (
              <li key={e.file}>
                <span className="font-mono text-red-300">{e.file}</span> — {e.message}
              </li>
            ))}
            {problems.map((p, i) => (
              <li key={`p${i}`}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <div className="mt-4">
          <CardEditor
            initial={editing.card ?? (editing.presetId ? { id: editing.presetId } : undefined)}
            isNew={editing.isNew}
            busy={busy}
            errors={problems}
            onSave={handleSave}
            onCancel={reset}
            onDelete={
              !editing.isNew && editing.card
                ? () => void remove(editing.card as LoadedCard)
                : undefined
            }
          />
        </div>
      )}

      <div className="mt-4 card !p-0 overflow-hidden">
        <div className="hidden sm:grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_5rem_6rem_minmax(0,1fr)_8rem] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-surface-700/60">
          <span>card</span>
          <span>id</span>
          <span className="text-right">windows</span>
          <span>source</span>
          <span>state</span>
          <span className="text-right">actions</span>
        </div>

        {cards.length === 0 && (
          <p className="px-4 py-6 text-[11px] text-zinc-500 italic">
            No cards loaded. Check the card directories, or create one.
          </p>
        )}

        {visible.length === 0 && cards.length > 0 && (
          <p className="px-4 py-4 text-[11px] text-zinc-500 italic">
            No card matches "{filter}".
          </p>
        )}

        {visible.map((card) => {
          const buckets = bucketsByProvider.get(card.id) ?? [];
          const measured = buckets.length > 0;
          const unavailable = measured && buckets.every((b) => b.unavailable);
          const palette = paletteOf(card.palette);
          const state = !card.shown
            ? measured
              ? `template · ${buckets.length} window${buckets.length === 1 ? '' : 's'}`
              : 'template (off)'
            : !measured
            ? 'waiting for data'
            : unavailable
              ? 'unavailable'
              : `${buckets.length} window${buckets.length === 1 ? '' : 's'}`;

          return (
            <div
              key={card.id}
              className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_5rem_6rem_minmax(0,1fr)_8rem] gap-x-3 gap-y-1 px-4 py-2.5 border-b border-surface-700/40 last:border-b-0 items-center hover:bg-surface-800/40 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`chip ${palette.badge} !px-1.5 !py-0 text-[10px] shrink-0`}>
                  {card.label}
                </span>
                {card.company && (
                  <span className="text-[11px] text-zinc-500 truncate">{card.company}</span>
                )}
              </div>
              <span className="font-mono text-[11px] text-zinc-400 truncate" title={card.source_path}>
                {card.id}
              </span>
              <span className="text-[11px] text-zinc-400 text-right tabular-nums">
                {card.windows.length === 0 ? 'dynamic' : card.windows.length}
              </span>
              <span className="text-[10px] uppercase tracking-wider">
                <span
                  className={
                    card.source === 'shipped'
                      ? 'text-sky-300/80'
                      : 'text-amber-300/80'
                  }
                >
                  {card.source}
                </span>
              </span>
              <span
                className={`text-[11px] truncate ${
                  !measured
                    ? 'text-zinc-500 italic'
                    : unavailable
                      ? 'text-zinc-500'
                      : 'text-emerald-300/90'
                }`}
              >
                {state}
              </span>
              <span className="flex items-center justify-end gap-2">
                <button
                  onClick={() => void toggleShown(card)}
                  disabled={busy}
                  title={
                    card.shown
                      ? 'Hide this card from the dashboard (stays in this list)'
                      : 'Show this card on the dashboard'
                  }
                  className={`px-2 py-1 text-[11px] rounded border transition-colors disabled:opacity-50 ${
                    card.shown
                      ? 'border-surface-700 text-zinc-300 hover:bg-surface-700'
                      : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                  }`}
                >
                  {card.shown ? 'Hide' : 'Show'}
                </button>
                <button
                  onClick={() => {
                    setProblems([]);
                    setNotice(null);
                    setEditing({ isNew: false, card });
                  }}
                  className="px-2 py-1 text-[11px] rounded border border-surface-700 bg-surface-800 hover:bg-surface-700 text-zinc-300 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => void remove(card)}
                  disabled={busy}
                  className="px-2 py-1 text-[11px] rounded border border-surface-700 text-zinc-400 hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                >
                  Delete
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {orphanIds.length > 0 && (
        <div className="mt-4 card">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            Providers with data but no card
          </p>
          <p className="text-[11px] text-zinc-500 mt-1">
            These buckets still render with a generic card. Create a card to give them a label,
            palette, console link and declared windows.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {orphanIds.map((id) => (
              <li key={id}>
                <button
                  onClick={() => {
                    setProblems([]);
                    setNotice(null);
                    setEditing({ isNew: true, presetId: id });
                  }}
                  className="chip bg-zinc-700/30 text-zinc-300 border border-zinc-600/50 hover:brightness-125 transition"
                  title={`Create a card for "${id}"`}
                >
                  + {id}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[10px] text-zinc-600">
        Cards are read from <span className="font-mono">config/cards/</span> (shipped) and{' '}
        <span className="font-mono">data/cards/</span> (yours); later wins. Changes apply without a
        restart or UI rebuild.
      </p>
    </section>
  );
}
