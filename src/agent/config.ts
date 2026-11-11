// =============================================================================
// Agent query config — CLI + MCP server
// =============================================================================
// The agent-facing query layer (CLI + MCP) lives in this checkout, so paths are
// derived from this file instead of pointing at a sibling directory. Anything
// operational is still overridable by environment variable.
// =============================================================================

// Load .env first so LLMQUOTA_* overrides can live there; OS env always wins.
import '../env.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: <root>/src/agent/config.ts → <root>. */
export const REPO_ROOT = path.resolve(here, '..', '..');

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  /** Where the scraper + package live (this checkout). */
  dashboardDir: REPO_ROOT,

  /** Snapshot written by the scraper daemon. */
  statePath: process.env.LLMQUOTA_STATE ?? path.join(REPO_ROOT, 'data', 'state.json'),

  /** Live dashboard API. Used first; falls back to the state file. */
  apiBase: (process.env.LLMQUOTA_API ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),

  /** Data older than this is refreshed on demand (when auto-refresh is on). */
  maxAgeSec: num(process.env.LLMQUOTA_MAX_AGE_SEC, 300),

  /** Set LLMQUOTA_AUTO_REFRESH=0 to never scrape implicitly. */
  autoRefresh: process.env.LLMQUOTA_AUTO_REFRESH !== '0',

  /** Hard limit for a one-shot scrape. */
  refreshTimeoutMs: num(process.env.LLMQUOTA_REFRESH_TIMEOUT_MS, 90_000),
};
