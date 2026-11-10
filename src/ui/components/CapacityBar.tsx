// =============================================================================
// CapacityBar — dual-colored progress bar (used vs. capacity expiring)
// =============================================================================
// Visual elements:
//   - Track: dim surface, full width
//   - Fill: gradient that shifts color based on used_pct
//   - Tick marker at "limit_window_hours" mark for periodic tiers
// =============================================================================

interface Props {
  used_pct: number;
  /** Optional extra class appended to the gradient fill (e.g. custom accent). */
  fillClass?: string;
  /** Hide entirely if true (e.g. metered buckets). */
  hidden?: boolean;
  /** Optional tick label rendered below the bar. */
  tickLabel?: string;
}

function fillGradient(used_pct: number): string {
  if (used_pct >= 95) return 'bg-gradient-to-r from-red-600 to-red-500';
  if (used_pct >= 80) return 'bg-gradient-to-r from-orange-500 to-amber-500';
  if (used_pct >= 60) return 'bg-gradient-to-r from-amber-500 to-yellow-400';
  if (used_pct >= 40) return 'bg-gradient-to-r from-sky-500 to-cyan-400';
  if (used_pct >= 20) return 'bg-gradient-to-r from-emerald-500 to-teal-400';
  return 'bg-gradient-to-r from-emerald-400 to-green-300';
}

export function CapacityBar({ used_pct, fillClass, hidden, tickLabel }: Props) {
  if (hidden) {
    return (
      <div className="h-2 w-full rounded-full bg-surface-700/40 flex items-center justify-center">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">balance-based</span>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, used_pct));
  const gradient = fillGradient(pct);

  return (
    <div>
      <div className="relative h-2.5 w-full rounded-full bg-surface-700/60 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 ${gradient} transition-all duration-700 ease-out ${fillClass ?? ''}`.trim()}
          style={{ width: `${pct}%` }}
        />
        {/* 100% guideline */}
        <div className="absolute inset-y-0 right-0 w-px bg-zinc-600/80" />
      </div>
      {tickLabel && (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{tickLabel}</div>
      )}
    </div>
  );
}