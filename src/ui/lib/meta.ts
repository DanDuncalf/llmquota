// =============================================================================
// Provider / status metadata — color & icon helpers
// =============================================================================
// Centralized so colors stay consistent across cards, header chips, and the
// "next recommendation" highlight.
// =============================================================================

import type { Provider, WasteRiskLevel } from '../../types/quota.js';

export interface ProviderMeta {
  label: string;
  color: string;       // tailwind text-* class
  bg: string;          // tailwind bg-* class
  border: string;      // tailwind border-* class
  badge: string;       // full chip classes
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  anthropic: {
    label: 'Anthropic',
    color: 'text-orange-300',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/40',
    badge: 'bg-orange-500/15 text-orange-300 border border-orange-500/40',
  },
  openai: {
    label: 'OpenAI',
    color: 'text-emerald-300',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/40',
    badge: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40',
  },
  gemini: {
    label: 'Antigravity',
    color: 'text-indigo-300',
    bg: 'bg-indigo-500/15',
    border: 'border-indigo-500/40',
    badge: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/40',
  },
  moonshot: {
    label: 'Moonshot',
    color: 'text-sky-300',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/40',
    badge: 'bg-sky-500/15 text-sky-300 border border-sky-500/40',
  },
  minimax: {
    label: 'MiniMax',
    color: 'text-fuchsia-300',
    bg: 'bg-fuchsia-500/15',
    border: 'border-fuchsia-500/40',
    badge: 'bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/40',
  },
  deepseek: {
    label: 'DeepSeek',
    color: 'text-blue-300',
    bg: 'bg-blue-500/15',
    border: 'border-blue-500/40',
    badge: 'bg-blue-500/15 text-blue-300 border border-blue-500/40',
  },
  deepinfra: {
    label: 'DeepInfra',
    color: 'text-teal-300',
    bg: 'bg-teal-500/15',
    border: 'border-teal-500/40',
    badge: 'bg-teal-500/15 text-teal-300 border border-teal-500/40',
  },
  qwen: {
    label: 'Qwen',
    color: 'text-violet-300',
    bg: 'bg-violet-500/15',
    border: 'border-violet-500/40',
    badge: 'bg-violet-500/15 text-violet-300 border border-violet-500/40',
  },
};

/** Compact token counts: 1234 → 1.2k, 1_234_567 → 1.23M. */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export interface StatusMeta {
  emoji: string;
  label: string;
  /** Full chip classes for the status pill. */
  chip: string;
  /** Color for the accent bar / ring around the card. */
  accent: string;
  description: string;
}

export function statusMeta(
  level: WasteRiskLevel,
  tier_type: string,
  isExhausted: boolean,
  isUnavailable = false,
): StatusMeta {
  if (isUnavailable) {
    return {
      emoji: '⚠️',
      label: 'UNAVAILABLE',
      chip: 'bg-zinc-600/20 text-zinc-400 border border-zinc-600/50',
      accent: 'before:bg-zinc-600',
      description: 'Could not read this window — see the note',
    };
  }
  if (isExhausted) {
    return {
      emoji: '🔴',
      label: 'COOLDOWN',
      chip: 'bg-red-500/20 text-red-300 border border-red-500/40',
      accent: 'before:bg-red-500',
      description: 'Quota exhausted — wait for reset',
    };
  }
  if (tier_type === 'metered') {
    return {
      emoji: '🪙',
      label: 'METERED STANDBY',
      chip: 'bg-blue-500/20 text-blue-300 border border-blue-500/40',
      accent: 'before:bg-blue-500',
      description: 'Pay-as-you-go — last-resort fallback',
    };
  }
  switch (level) {
    case 'CRITICAL':
      return {
        emoji: '⚡',
        label: 'HIGH PRIORITY',
        chip: 'bg-amber-500/20 text-amber-300 border border-amber-500/50 animate-pulse-slow',
        accent: 'before:bg-amber-500',
        description: 'Use now — expiring free capacity',
      };
    case 'HIGH':
      return {
        emoji: '🟧',
        label: 'HIGH',
        chip: 'bg-orange-500/20 text-orange-300 border border-orange-500/40',
        accent: 'before:bg-orange-500',
        description: 'Prefer over MODERATE buckets',
      };
    case 'MODERATE':
      return {
        emoji: '🟢',
        label: 'ACTIVE',
        chip: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40',
        accent: 'before:bg-emerald-500',
        description: 'Ready to accept requests',
      };
    case 'LOW':
      return {
        emoji: '🟦',
        label: 'LOW',
        chip: 'bg-zinc-500/15 text-zinc-300 border border-zinc-500/40',
        accent: 'before:bg-zinc-500',
        description: 'Mostly used — deprioritize',
      };
    case 'NONE':
    default:
      return {
        emoji: '⚪',
        label: 'UNAVAILABLE',
        chip: 'bg-zinc-500/15 text-zinc-300 border border-zinc-500/40',
        accent: 'before:bg-zinc-500',
        description: 'Not available right now',
      };
  }
}