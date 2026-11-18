// =============================================================================
// API client — typed fetch wrapper for the local Express server
// =============================================================================

import type { DashboardSummary, NormalizedQuotaBucket, QuotaStateFile } from '../../types/quota.js';
// Type-only import: the card schema module pulls in zod, which must not ship in
// the browser bundle. Runtime validation happens server-side.
import type { CardSpec } from '../../cards/spec.js';

/** A card spec as served by the API (spec + where it was loaded from). */
export interface LoadedCard extends CardSpec {
  source: 'shipped' | 'user';
  source_path: string;
}

export interface CardLoadError {
  file: string;
  message: string;
}

export interface QuotaStateResponse {
  state: QuotaStateFile;
  summary: DashboardSummary;
  /** Cards travel with the data so the UI needs no rebuild to render a new one. */
  cards?: LoadedCard[];
  card_errors?: CardLoadError[];
}

export interface CardsResponse {
  cards: LoadedCard[];
  errors: CardLoadError[];
  dirs: string[];
  writable_dir?: string;
}

export class ApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = 'ApiError';
  }
}

/** Pull `{ errors: string[] }` out of a failed response, falling back to HTTP. */
async function failure(r: Response): Promise<ApiError> {
  let message = `HTTP ${r.status}`;
  let details: string[] = [];
  try {
    const body: unknown = await r.json();
    const b = body as { message?: string; errors?: unknown; error?: string };
    if (Array.isArray(b?.errors)) details = b.errors.filter((e): e is string => typeof e === 'string');
    if (typeof b?.message === 'string') message = b.message;
    else if (typeof b?.error === 'string') message = b.error;
    else if (details.length > 0) message = details.join('; ');
  } catch {
    /* not JSON */
  }
  return new ApiError(r.status, message, details);
}

export async function fetchQuotaState(): Promise<QuotaStateResponse> {
  const r = await fetch('/api/quota-state', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as QuotaStateResponse;
}

export async function fetchCards(): Promise<CardsResponse> {
  const r = await fetch('/api/cards', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as CardsResponse;
}

/** Create or update one card. Server validates and returns it. */
export async function saveCard(id: string, spec: unknown): Promise<{ ok: true; card: LoadedCard }> {
  const r = await fetch(`/api/cards/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as { ok: true; card: LoadedCard };
}

export async function deleteCard(id: string): Promise<{ ok: true; file?: string }> {
  const r = await fetch(`/api/cards/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as { ok: true; file?: string };
}

/** Re-scrape one card on the server and merge its buckets into state.json. */
export async function refreshCard(id: string): Promise<{ ok: true; buckets: number }> {
  const r = await fetch(`/api/cards/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw await failure(r);
  return (await r.json()) as { ok: true; buckets: number };
}

export interface HealthStatus {
  ok: boolean;
  state_present: boolean;
  state_generated_at: string | null;
  bucket_count: number;
  card_count?: number;
  card_errors?: CardLoadError[];
  orphan_providers?: string[];
  cards_without_data?: string[];
}

export async function fetchHealth(): Promise<HealthStatus> {
  const r = await fetch('/api/health');
  if (!r.ok) throw await failure(r);
  return (await r.json()) as HealthStatus;
}

export type { DashboardSummary, NormalizedQuotaBucket, QuotaStateFile };
