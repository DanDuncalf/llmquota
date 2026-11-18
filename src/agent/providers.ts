// =============================================================================
// Provider metadata + query aliases — derived from the card registry
// =============================================================================
// Cards are data (config/cards/*.json), so the agent's notion of "what
// providers exist" must come from the same place as the dashboard's. Each card
// declares its own aliases (and, where relevant, the CLI harness it is reached
// through). A card added at runtime is immediately queryable.
// =============================================================================

import type { Provider } from '../types/quota.js';
import { loadRegistry } from '../cards/registry.js';

export interface ProviderMeta {
  id: Provider;
  /** Short agent-facing name, e.g. "Kimi". */
  label: string;
  /** Company that owns the subscription, e.g. "Moonshot AI". */
  company: string;
  /** Set when quota is reached through a CLI harness (Gemini via Agy). */
  harness?: string;
  /** Models the harness serves — used only for query matching. */
  catalog?: string[];
  aliases: string[];
}

/** Every registered card, in display order. */
export function providers(): ProviderMeta[] {
  return loadRegistry().cards.map((card) => ({
    id: card.id,
    label: card.label,
    company: card.company ?? card.label,
    aliases: card.aliases.length > 0 ? card.aliases : [card.id, card.label.toLowerCase()],
    ...(card.agent?.harness ? { harness: card.agent.harness } : {}),
    ...(card.agent?.serves ? { catalog: card.agent.serves } : {}),
  }));
}

export function providerMeta(id: string): ProviderMeta {
  const found = providers().find((p) => p.id === id);
  return (
    found ?? {
      id,
      label: id,
      company: id,
      aliases: [id],
    }
  );
}

/**
 * Loose but predictable alias match:
 *   - exact match always wins
 *   - long aliases (>= 4 chars) match as substrings in either direction,
 *     so "claude" matches "claude code" and "kimi-for-coding" matches "kimi"
 *   - short aliases (o1, k2, m2) only match exactly, to avoid false positives
 */
export function aliasMatches(query: string, alias: string): boolean {
  const q = query.toLowerCase().trim();
  const a = alias.toLowerCase();
  if (!q) return false;
  if (q === a) return true;
  if (a.length <= 3 || q.length <= 3) return false;
  return q.includes(a) || a.includes(q);
}
