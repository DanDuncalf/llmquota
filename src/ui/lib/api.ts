// =============================================================================
// API client — typed fetch wrapper for the local Express server
// =============================================================================

import type { DashboardSummary, NormalizedQuotaBucket, QuotaStateFile } from '../../types/quota.js';

export interface QuotaStateResponse {
  state: QuotaStateFile;
  summary: DashboardSummary;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export async function fetchQuotaState(): Promise<QuotaStateResponse> {
  const r = await fetch('/api/quota-state', { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.message) detail = body.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(r.status, detail);
  }
  return (await r.json()) as QuotaStateResponse;
}

export interface HealthStatus {
  ok: boolean;
  state_present: boolean;
  state_generated_at: string | null;
  bucket_count: number;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const r = await fetch('/api/health');
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
  return (await r.json()) as HealthStatus;
}

export type { DashboardSummary, NormalizedQuotaBucket, QuotaStateFile };