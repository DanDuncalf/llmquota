// =============================================================================
// Card order + sort-mode persistence (browser-side, localStorage)
// =============================================================================
// Dragging a card stores the resulting key order under CARD_ORDER_KEY and
// switches the dashboard to the "custom" sort mode. Keys are
// `${provider}:${account ?? ''}` — the same shape used as the React key — so
// multi-account providers (two Gemini logins) stay independently draggable.
// Cards that aren't in the stored order (a newly added provider) fall back to
// alphabetical order after the known ones, then get captured on the next drag.
// =============================================================================

export const CARD_ORDER_KEY = 'quota-dashboard.card-order.v1';
export const SORT_MODE_KEY = 'quota-dashboard.card-sort.v1';

/**
 * Card ordering.
 *   alpha        — A→Z by provider label
 *   availability — available with the most weekly capacity left first, then
 *                  metered accounts by highest balance, then unavailable
 *   custom       — the drag-and-drop order the user arranged
 */
export type SortMode = 'alpha' | 'availability' | 'custom';

export function cardKey(provider: string, account?: string): string {
  return `${provider}:${account ?? ''}`;
}

/**
 * Move `sourceKey` to `targetKey`'s position, shifting the rest along.
 * Returns null when either key isn't present (stale drag / unknown card), so
 * callers can leave the stored order untouched.
 */
export function moveKey(order: string[], sourceKey: string, targetKey: string): string[] | null {
  const from = order.indexOf(sourceKey);
  const to = order.indexOf(targetKey);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, sourceKey);
  return next;
}

export function loadCardOrder(): string[] {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCardOrder(order: string[]): void {
  try {
    localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* private mode / quota — the order just won't survive a reload */
  }
}

export function loadSortMode(fallback: SortMode = 'alpha'): SortMode {
  try {
    const raw = localStorage.getItem(SORT_MODE_KEY);
    if (raw === 'alpha' || raw === 'availability' || raw === 'custom') return raw;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function saveSortMode(mode: SortMode): void {
  try {
    localStorage.setItem(SORT_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}
