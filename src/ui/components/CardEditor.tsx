// =============================================================================
// CardEditor — add / edit one card specification
// =============================================================================
// A plain form over the card JSON. Validation is server-side (zod in
// src/cards/spec.ts) so there is exactly one definition of a valid card; this
// form only shapes input and renders the returned errors.
// =============================================================================

import { useState } from 'react';
import { PALETTE_NAMES, WINDOW_DISPLAYS, WINDOW_KINDS, WINDOW_TIERS } from '../../cards/vocab.js';
import type { CardSpec, CardWindow } from '../../cards/spec.js';
import { paletteOf } from '../lib/meta.js';

interface WindowDraft {
  id: string;
  label: string;
  kind: string;
  tier: string;
  hours: string;
  display: string;
  limit_label: string;
}

interface Draft {
  id: string;
  label: string;
  company: string;
  url: string;
  palette: string;
  order: string;
  aliases: string;
  windows: WindowDraft[];
  usageCatalog: string;
  usageLogs: string;
  usageMonthly: boolean;
  notes: string;
  shown: boolean;
}

function toDraft(spec: Partial<CardSpec> | undefined, id = ''): Draft {
  const s = spec;
  return {
    id: s?.id ?? id,
    label: s?.label ?? id,
    company: s?.company ?? '',
    url: s?.url ?? '',
    palette: s?.palette ?? 'zinc',
    order: String(s?.order ?? 500),
    aliases: (s?.aliases ?? []).join(', '),
    windows: (s?.windows ?? []).map((w) => ({
      id: w.id,
      label: w.label,
      kind: w.kind ?? 'other',
      tier: w.tier ?? 'rolling_window',
      hours: w.hours === undefined ? '' : String(w.hours),
      display: w.display ?? 'percent',
      limit_label: w.limit_label ?? '',
    })),
    usageCatalog: s?.usage?.catalog ?? '',
    usageLogs: s?.usage?.logs ?? '',
    usageMonthly: s?.usage?.monthly === true,
    notes: s?.notes ?? '',
    shown: s?.shown ?? true,
  };
}

function blankWindow(): WindowDraft {
  return {
    id: '',
    label: '',
    kind: 'other',
    tier: 'rolling_window',
    hours: '',
    display: 'percent',
    limit_label: '',
  };
}

/** Draft → the payload the API expects. Empty optional fields are omitted. */
function toPayload(d: Draft): Record<string, unknown> {
  const windows: CardWindow[] = d.windows
    .filter((w) => w.id.trim() && w.label.trim())
    .map((w) => ({
      id: w.id.trim(),
      label: w.label.trim(),
      kind: w.kind as CardWindow['kind'],
      tier: w.tier as CardWindow['tier'],
      display: w.display as CardWindow['display'],
      ...(w.hours.trim() ? { hours: Number(w.hours) } : {}),
      ...(w.limit_label.trim() ? { limit_label: w.limit_label.trim() } : {}),
    }));

  const usage: Record<string, unknown> = {};
  if (d.usageCatalog.trim()) usage.catalog = d.usageCatalog.trim();
  if (d.usageLogs.trim()) usage.logs = d.usageLogs.trim();
  if (d.usageMonthly) usage.monthly = true;

  return {
    id: d.id.trim(),
    label: d.label.trim(),
    ...(d.company.trim() ? { company: d.company.trim() } : {}),
    ...(d.url.trim() ? { url: d.url.trim() } : {}),
    palette: d.palette,
    order: Number(d.order) || 0,
    aliases: d.aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    shown: d.shown,
    windows,
    usage,
    ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
  };
}

const labelCls = 'block text-[10px] uppercase tracking-wider text-zinc-500 mb-1';
const inputCls =
  'w-full bg-surface-900 border border-surface-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 ' +
  'placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50';

export function CardEditor({
  initial,
  isNew,
  busy,
  errors,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Partial<CardSpec> | undefined;
  isNew: boolean;
  busy: boolean;
  errors: string[];
  onSave: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setWindow = (index: number, patch: Partial<WindowDraft>): void =>
    setDraft((d) => ({
      ...d,
      windows: d.windows.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    }));

  return (
    <form
      className="card border-accent-500/40"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(toPayload(draft));
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">
            {isNew ? 'New card' : `Edit ${initial && 'label' in initial ? initial.label : draft.id}`}
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Saved as JSON in the writable card directory. Renders on the dashboard within one
            scraper tick — no restart.
          </p>
        </div>
        <span
          className={`chip ${paletteOf(draft.palette).badge} !px-2 !py-0.5 shrink-0`}
          title="Card palette preview"
        >
          {draft.label || 'preview'}
        </span>
      </div>

      {errors.length > 0 && (
        <ul className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label>
          <span className={labelCls}>id (provider key)</span>
          <input
            className={inputCls}
            value={draft.id}
            disabled={!isNew}
            placeholder="e.g. mistral"
            onChange={(e) => set('id', e.target.value)}
            required
          />
        </label>
        <label>
          <span className={labelCls}>label</span>
          <input
            className={inputCls}
            value={draft.label}
            placeholder="e.g. Mistral"
            onChange={(e) => set('label', e.target.value)}
            required
          />
        </label>
        <label>
          <span className={labelCls}>company</span>
          <input
            className={inputCls}
            value={draft.company}
            placeholder="e.g. Mistral AI"
            onChange={(e) => set('company', e.target.value)}
          />
        </label>
        <label>
          <span className={labelCls}>console url</span>
          <input
            className={inputCls}
            value={draft.url}
            placeholder="https://…"
            onChange={(e) => set('url', e.target.value)}
          />
        </label>
        <label>
          <span className={labelCls}>palette</span>
          <select
            className={inputCls}
            value={draft.palette}
            onChange={(e) => set('palette', e.target.value)}
          >
            {PALETTE_NAMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>order (lower = further left)</span>
          <input
            className={inputCls}
            type="number"
            value={draft.order}
            onChange={(e) => set('order', e.target.value)}
          />
        </label>
        <label className="flex items-end gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={draft.shown}
            onChange={(e) => set('shown', e.target.checked)}
          />
          <span className="text-[11px] text-zinc-400">
            shown on the dashboard (off = hidden template)
          </span>
        </label>
        <label className="sm:col-span-2">
          <span className={labelCls}>agent aliases (comma separated)</span>
          <input
            className={inputCls}
            value={draft.aliases}
            placeholder="mistral, mixtral, magistral"
            onChange={(e) => set('aliases', e.target.value)}
          />
        </label>
        <label>
          <span className={labelCls}>catalog source</span>
          <input
            className={inputCls}
            value={draft.usageCatalog}
            placeholder="api:mistral / local:qwen / observed"
            onChange={(e) => set('usageCatalog', e.target.value)}
          />
        </label>
        <label>
          <span className={labelCls}>local log family</span>
          <input
            className={inputCls}
            value={draft.usageLogs}
            placeholder="claude / codex / kimi / qwen"
            onChange={(e) => set('usageLogs', e.target.value)}
          />
        </label>
        <label className="flex items-end gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={draft.usageMonthly}
            onChange={(e) => set('usageMonthly', e.target.checked)}
          />
          <span className="text-[11px] text-zinc-400">billing API reports monthly tokens</span>
        </label>
      </div>

      {/* --- windows ------------------------------------------------------- */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            quota windows ({draft.windows.length})
          </span>
          <button
            type="button"
            onClick={() => set('windows', [...draft.windows, blankWindow()])}
            className="text-[11px] text-accent-400 hover:text-accent-500"
          >
            + add window
          </button>
        </div>
        <p className="text-[11px] text-zinc-600 mt-1">
          Empty list = render whatever the scraper reports (use this for per-account cards like
          Gemini). Otherwise a declared window the scraper does not report shows as UNAVAILABLE.
        </p>

        {draft.windows.map((w, i) => (
          <div
            key={i}
            className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 items-end rounded-md border border-surface-700/60 p-2"
          >
            <label className="col-span-1">
              <span className={labelCls}>window id</span>
              <input
                className={inputCls}
                value={w.id}
                placeholder="mistral-5h"
                onChange={(e) => setWindow(i, { id: e.target.value })}
              />
            </label>
            <label className="col-span-1">
              <span className={labelCls}>label</span>
              <input
                className={inputCls}
                value={w.label}
                placeholder="5h session"
                onChange={(e) => setWindow(i, { label: e.target.value })}
              />
            </label>
            <label>
              <span className={labelCls}>kind</span>
              <select
                className={inputCls}
                value={w.kind}
                onChange={(e) => setWindow(i, { kind: e.target.value })}
              >
                {WINDOW_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelCls}>tier</span>
              <select
                className={inputCls}
                value={w.tier}
                onChange={(e) => setWindow(i, { tier: e.target.value })}
              >
                {WINDOW_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelCls}>hours</span>
              <input
                className={inputCls}
                type="number"
                value={w.hours}
                placeholder="5"
                onChange={(e) => setWindow(i, { hours: e.target.value })}
              />
            </label>
            <label>
              <span className={labelCls}>display</span>
              <select
                className={inputCls}
                value={w.display}
                onChange={(e) => setWindow(i, { display: e.target.value })}
              >
                {WINDOW_DISPLAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex gap-1 items-end">
              <span className="flex-1">
                <span className={labelCls}>limit label</span>
                <input
                  className={inputCls}
                  value={w.limit_label}
                  placeholder="Pro plan"
                  onChange={(e) => setWindow(i, { limit_label: e.target.value })}
                />
              </span>
              <button
                type="button"
                title="Remove window"
                onClick={() =>
                  set(
                    'windows',
                    draft.windows.filter((_, index) => index !== i),
                  )
                }
                className="px-1.5 py-1.5 text-[11px] rounded border border-surface-700 text-zinc-400 hover:text-red-300 hover:border-red-500/40"
              >
                ✕
              </button>
            </label>
          </div>
        ))}
      </div>

      <label className="block mt-4">
        <span className={labelCls}>notes</span>
        <textarea
          className={`${inputCls} h-16 resize-y`}
          value={draft.notes}
          placeholder="Why this card exists / what it cannot report"
          onChange={(e) => set('notes', e.target.value)}
        />
      </label>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md bg-accent-500 hover:bg-accent-600 text-white disabled:opacity-50 transition-colors"
          >
            {busy ? 'Saving…' : isNew ? 'Create card' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md border border-surface-700 bg-surface-800 hover:bg-surface-700 text-zinc-300 transition-colors"
          >
            Cancel
          </button>
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="px-3 py-1.5 text-xs rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 transition-colors"
          >
            Delete card
          </button>
        )}
      </div>
    </form>
  );
}
