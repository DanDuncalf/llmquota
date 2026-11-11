// =============================================================================
// Provider metadata + query aliases
// =============================================================================
// `id` matches the Provider ids emitted by the scraper into state.json.
// Aliases are what an agent (or a human) might plausibly type.
// =============================================================================

import type { Provider } from '../types/quota.js';

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

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    company: 'Anthropic',
    aliases: ['anthropic', 'claude', 'claude code', 'claudeai', 'sonnet', 'opus', 'haiku'],
  },
  {
    id: 'openai',
    label: 'ChatGPT',
    company: 'OpenAI',
    aliases: ['openai', 'open ai', 'chatgpt', 'chat gpt', 'codex', 'gpt', 'o1', 'o3', 'o4', 'o5'],
  },
  {
    id: 'gemini',
    label: 'Gemini (Agy)',
    company: 'Google',
    harness: 'agy',
    // Models the Agy harness serves (agy models). Used only for query matching.
    catalog: [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ],
    aliases: [
      'gemini',
      'gemini cli',
      'gemini-cli',
      'agy',
      'antigravity',
      'antigravity cli',
      'agy harness',
      'google',
      'google ai',
      'google gemini',
    ],
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    company: 'Moonshot AI',
    aliases: ['moonshot', 'kimi', 'kimi code', 'kimi-code', 'k2', 'k3', 'kimi-for-coding'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    company: 'MiniMax',
    aliases: ['minimax', 'mini max', 'm2', 'm2.7'],
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    company: 'DeepInfra',
    aliases: ['deepinfra', 'deep infra'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    company: 'DeepSeek',
    aliases: ['deepseek', 'deep seek'],
  },
  {
    id: 'qwen',
    label: 'Qwen',
    company: 'Alibaba Cloud',
    aliases: ['qwen', 'alibaba', 'alibaba cloud', 'modelstudio', 'tongyi', 'qwen code'],
  },
];

const BY_ID = new Map<string, ProviderMeta>(PROVIDERS.map((p) => [p.id, p]));

export function providerMeta(id: string): ProviderMeta {
  return (
    BY_ID.get(id) ?? {
      id: id as Provider,
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
