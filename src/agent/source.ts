// =============================================================================
// Agent data source
// =============================================================================
// The scraper daemon writes data/state.json every 60s and the Express API
// serves that same state. Read order:
//
//   1. live API  (127.0.0.1:8787/api/quota-state) — confirms the daemon is up
//   2. state.json on disk                         — works even with no server
//   3. one-shot scrape of this checkout           — only when the snapshot is
//                                                   stale and refresh is allowed
//
// A one-shot scrape is the same code the dashboard daemon runs, with --once.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from './config.js';
import type { AgentState } from './normalize.js';

export type StateSource = 'api' | 'file';

export interface ReadStateResult {
  state: AgentState;
  source: StateSource;
  api_up: boolean;
}

export interface LoadedState extends ReadStateResult {
  refreshed: boolean;
  refresh_error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function isStateFile(value: unknown): value is AgentState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as AgentState).buckets)
  );
}

/** Parse state.json, retrying briefly in case the scraper is mid-write. */
function readStateFile(): AgentState {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = fs.readFileSync(CONFIG.statePath, 'utf8');
      const state: unknown = JSON.parse(raw);
      if (!isStateFile(state)) throw new Error('state.json has no buckets');
      return state;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        // synchronous sleep keeps readState simple; this path is rare
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      }
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : 'unknown error';
  throw new Error(`cannot read quota state at ${CONFIG.statePath}: ${message}`);
}

/** Read the newest snapshot available. */
export async function readState(): Promise<ReadStateResult> {
  try {
    const payload = (await fetchJson(`${CONFIG.apiBase}/api/quota-state`, 2_500)) as {
      state?: unknown;
    };
    if (isStateFile(payload?.state)) {
      return { state: payload.state, source: 'api', api_up: true };
    }
  } catch {
    // dashboard not running — fall through to disk
  }
  return { state: readStateFile(), source: 'file', api_up: false };
}

export function stateAgeSeconds(state: AgentState): number {
  const ts = Date.parse(state?.generated_at ?? '');
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

let inFlightRefresh: Promise<ReadStateResult> | null = null;

/**
 * Run the scraper once, then re-read the file it wrote.
 * Concurrent callers in this process share one scrape.
 */
export function refreshState(): Promise<ReadStateResult> {
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function doRefresh(): Promise<ReadStateResult> {
  const tsxCli = path.join(CONFIG.dashboardDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`cannot refresh: ${tsxCli} not found (run npm install in ${CONFIG.dashboardDir})`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, 'src/scraper/index.ts', '--once'], {
      cwd: CONFIG.dashboardDir,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`scrape timed out after ${CONFIG.refreshTimeoutMs}ms`));
    }, CONFIG.refreshTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const tail = stderr ? `: ${stderr.trim().split('\n').pop()}` : '';
        reject(new Error(`scraper exited ${code}${tail}`));
      }
    });
  });

  // Let the file settle, then read it (deliberately skip the API so we observe
  // the snapshot we just produced).
  await sleep(100);
  return { state: readStateFile(), source: 'file', api_up: false };
}

export interface LoadOptions {
  /** true = force, false = never, undefined = auto when stale. */
  refresh?: boolean;
  maxAgeSec?: number;
}

/** Load data, optionally refreshing when stale. */
export async function loadState(opts: LoadOptions = {}): Promise<LoadedState> {
  const maxAgeSec = opts.maxAgeSec ?? CONFIG.maxAgeSec;
  const first = await readState();
  const age = stateAgeSeconds(first.state);

  const shouldRefresh =
    opts.refresh === true ||
    (opts.refresh !== false && CONFIG.autoRefresh && age > maxAgeSec);

  if (!shouldRefresh) {
    return { ...first, refreshed: false, refresh_error: null };
  }

  try {
    const fresh = await refreshState();
    return { ...fresh, refreshed: true, refresh_error: null };
  } catch (err) {
    // Keep serving the snapshot we have; the caller surfaces the warning.
    return {
      ...first,
      refreshed: false,
      refresh_error: err instanceof Error ? err.message : String(err),
    };
  }
}
