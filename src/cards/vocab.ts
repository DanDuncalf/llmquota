// =============================================================================
// Card vocabulary — friendly to both the browser and the server
// =============================================================================
// The enum-like parts of a card spec live here, WITHOUT zod, so UI components
// can import the runtime arrays (`WINDOW_KINDS` for a <select>, …) without
// dragging zod into the browser bundle. src/cards/spec.ts builds its zod
// schemas on top of these.
// =============================================================================

/** Palette names only — the Tailwind class strings live in ui/lib/meta.ts so
 *  that Tailwind's content scanner can see every class it must emit. */
export const PALETTE_NAMES = [
  'orange',
  'emerald',
  'indigo',
  'sky',
  'fuchsia',
  'blue',
  'teal',
  'violet',
  'rose',
  'amber',
  'zinc',
] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

/** What a window means, semantically. Replaces label regexes elsewhere. */
export const WINDOW_KINDS = [
  'five_hour',
  'weekly',
  'daily',
  'monthly',
  'metered',
  'other',
] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const WINDOW_TIERS = ['rolling_window', 'periodic_fixed', 'metered'] as const;
export type WindowTier = (typeof WINDOW_TIERS)[number];

/** How the row body is rendered. A closed vocabulary keeps ProviderCard
 *  provider-agnostic: it switches on this, never on a provider id. */
export const WINDOW_DISPLAYS = ['percent', 'currency', 'note'] as const;
export type WindowDisplay = (typeof WINDOW_DISPLAYS)[number];

/** Card ids double as the `provider` value in state.json, the join key for the
 *  UI's drag order, and the JSON filename. Keep them URL/filename safe. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
