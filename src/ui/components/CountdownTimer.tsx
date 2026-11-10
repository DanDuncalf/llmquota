// =============================================================================
// CountdownTimer — HH:MM:SS that ticks every second
// =============================================================================
// Receives a target ISO timestamp (or seconds-from-now). Updates every 1s and
// shows zero when expired. Pure CSS, no extra deps.
// =============================================================================

import { useEffect, useState } from 'react';

interface Props {
  /** Seconds remaining until reset. Treated as authoritative. */
  reset_in_seconds: number;
  /** Optional ISO timestamp to display as a tooltip on hover. */
  resets_at?: string;
  /** Display variant — 'mono' (default) or 'plain'. */
  variant?: 'mono' | 'plain';
  className?: string;
}

function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

export function CountdownTimer({ reset_in_seconds, resets_at, variant = 'mono', className }: Props) {
  // Start with the value passed in, then decrement locally each second so the
  // card stays smooth between server polls.
  const [remaining, setRemaining] = useState(reset_in_seconds);

  // Re-sync whenever the server sends a fresh value (it will jump up or down).
  useEffect(() => {
    setRemaining(reset_in_seconds);
  }, [reset_in_seconds]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const isUrgent = remaining > 0 && remaining < 3600;
  const isExpired = remaining <= 0;

  const base =
    variant === 'mono'
      ? 'font-mono tabular-nums tracking-tight'
      : 'font-sans';

  const color = isExpired
    ? 'text-zinc-500'
    : isUrgent
      ? 'text-amber-300'
      : 'text-zinc-300';

  return (
    <span
      className={`${base} ${color} ${className ?? ''}`}
      title={resets_at ? `Resets at ${new Date(resets_at).toLocaleString()}` : undefined}
    >
      {isExpired ? 'resetting…' : formatHMS(remaining)}
    </span>
  );
}