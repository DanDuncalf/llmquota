// =============================================================================
// Local token-usage scanner
// =============================================================================
// Provider APIs mostly do NOT expose per-model token counts — but the CLI
// agents on this machine write them to disk. We read those append-only JSONL
// logs and roll them up into 1h / 5h / 24h totals per model.
//
// Sources (all optional — a missing dir is simply skipped):
//
//   Claude Code  ~/.claude/projects/**/*.jsonl
//                message.model + message.usage.{input_tokens, output_tokens,
//                cache_read_input_tokens, cache_creation_input_tokens}
//
//   Codex CLI    ~/.codex/sessions/**/*.jsonl
//                event_msg / token_count → info.last_token_usage
//                {input_tokens, output_tokens, reasoning_output_tokens,
//                 cached_input_tokens, cache_write_input_tokens}
//                (model comes from the surrounding turn_context events)
//
//   Kimi Code    ~/.kimi-code/sessions/**/wire.jsonl
//                {type:"usage.record", model, usage:{inputOther, output,
//                 inputCacheRead, inputCacheCreation}, time: epoch-ms}
//
//   Qwen CLI     ~/.qwen/projects/**/chats/*.jsonl
//                {type:"assistant", model, usageMetadata:{promptTokenCount,
//                 candidatesTokenCount, thoughtsTokenCount,
//                 cachedContentTokenCount}}
//
// Design notes:
//   * Only files modified inside the lookback window are opened (default 26h),
//     so a 1 GB session archive costs nothing on a quiet day.
//   * Large files are tailed (last MAX_FILE_BYTES) rather than read whole.
//   * Records are attributed to a provider by model NAME first (so a MiniMax
//     model used through the Qwen CLI lands under MiniMax), falling back to the
//     source's own provider.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Provider, TokenTally } from '../../types/quota.js';

const HOME = os.homedir();

const LOOKBACK_HOURS = Number(process.env.USAGE_LOOKBACK_HOURS ?? 26);
const MAX_FILE_BYTES = Number(process.env.USAGE_MAX_FILE_BYTES ?? 16 * 1024 * 1024);
const MAX_FILES_PER_SOURCE = Number(process.env.USAGE_MAX_FILES ?? 400);

export interface UsageEvent {
  ts: number; // epoch ms
  model: string;
  provider: Provider;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// -----------------------------------------------------------------------------
// Provider attribution
// -----------------------------------------------------------------------------
export function attributeProvider(model: string, hint: Provider): Provider {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o[1-4]|codex)/.test(m) || m.includes('codex')) return 'openai';
  if (m.startsWith('kimi') || m.includes('moonshot')) return 'moonshot';
  if (m.startsWith('minimax') || m.startsWith('abab') || /^m2[.\-]/.test(m)) return 'minimax';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('qwen')) return 'qwen';
  // DeepInfra model ids are "org/model" — checked last so family prefixes win.
  if (m.includes('/')) {
    const tail = m.split('/').pop() ?? m;
    if (tail.startsWith('kimi') || tail.includes('moonshot')) return 'moonshot';
    if (tail.startsWith('qwen')) return 'qwen';
    if (tail.startsWith('deepseek')) return 'deepseek';
    if (tail.startsWith('minimax')) return 'minimax';
    return 'deepinfra';
  }
  return hint;
}

// -----------------------------------------------------------------------------
// Source definitions
// -----------------------------------------------------------------------------
interface Source {
  name: string;
  hint: Provider;
  root: string;
  matchName: (name: string) => boolean;
  parse: (o: Record<string, unknown>) => UsageEvent | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;

/** Claude Code transcripts. */
function parseClaude(o: Record<string, unknown>): UsageEvent | null {
  if (o.type !== 'assistant') return null;
  const msg = obj(o.message);
  if (!msg) return null;
  const model = str(msg.model);
  const usage = obj(msg.usage);
  if (!model || !usage) return null;
  const ts = Date.parse(str(o.timestamp) ?? '');
  if (Number.isNaN(ts)) return null;
  return {
    ts,
    model,
    provider: 'anthropic',
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
}

/** Codex rollout files: token_count events carry per-turn deltas. */
function parseCodex(o: Record<string, unknown>): UsageEvent | null {
  if (o.type !== 'event_msg') return null;
  const payload = obj(o.payload);
  if (!payload || payload.type !== 'token_count') return null;
  const info = obj(payload.info);
  if (!info) return null;
  const last = obj(info.last_token_usage);
  if (!last) return null;
  const ts = Date.parse(str(o.timestamp) ?? '');
  if (Number.isNaN(ts)) return null;
  return {
    ts,
    model: str(info.model) ?? '', // filled from surrounding context if empty
    provider: 'openai',
    input: num(last.input_tokens),
    output: num(last.output_tokens) + num(last.reasoning_output_tokens),
    cacheRead: num(last.cached_input_tokens),
    cacheWrite: num(last.cache_write_input_tokens),
  };
}

/** Kimi Code wire.jsonl. */
function parseKimi(o: Record<string, unknown>): UsageEvent | null {
  if (o.type !== 'usage.record') return null;
  const usage = obj(o.usage);
  const ts = num(o.time);
  if (!usage || !ts) return null;
  return {
    ts,
    model: str(o.model) ?? 'kimi',
    provider: 'moonshot',
    input: num(usage.inputOther),
    output: num(usage.output),
    cacheRead: num(usage.inputCacheRead),
    cacheWrite: num(usage.inputCacheCreation),
  };
}

/** Qwen CLI chat transcripts. */
function parseQwen(o: Record<string, unknown>): UsageEvent | null {
  if (o.type !== 'assistant') return null;
  const um = obj(o.usageMetadata);
  const model = str(o.model);
  if (!um || !model) return null;
  const ts = Date.parse(str(o.timestamp) ?? '');
  if (Number.isNaN(ts)) return null;
  return {
    ts,
    model,
    provider: 'qwen',
    input: num(um.promptTokenCount),
    output: num(um.candidatesTokenCount) + num(um.thoughtsTokenCount),
    cacheRead: num(um.cachedContentTokenCount),
    cacheWrite: 0,
  };
}

const SOURCES: Source[] = [
  {
    name: 'claude',
    hint: 'anthropic',
    root: path.join(HOME, '.claude', 'projects'),
    matchName: (n) => n.endsWith('.jsonl'),
    parse: parseClaude,
  },
  {
    name: 'codex',
    hint: 'openai',
    root: path.join(HOME, '.codex', 'sessions'),
    matchName: (n) => n.endsWith('.jsonl'),
    parse: parseCodex,
  },
  {
    name: 'kimi',
    hint: 'moonshot',
    root: path.join(HOME, '.kimi-code', 'sessions'),
    matchName: (n) => n === 'wire.jsonl',
    parse: parseKimi,
  },
  {
    name: 'qwen',
    hint: 'qwen',
    root: path.join(HOME, '.qwen', 'projects'),
    matchName: (n) => n.endsWith('.jsonl'),
    parse: parseQwen,
  },
];

// -----------------------------------------------------------------------------
// Filesystem walk
// -----------------------------------------------------------------------------
interface Candidate {
  file: string;
  mtimeMs: number;
}

interface Candidates {
  /** Files touched inside the lookback window, newest first. */
  recent: Candidate[];
  /** Newest mtime seen among ALL matching files (even stale ones). */
  latestMtime: number;
  /** How many matching files exist in total. */
  totalFiles: number;
}

function findRecentFiles(source: Source, cutoffMs: number): Candidates {
  const recent: Candidate[] = [];
  let latestMtime = 0;
  let totalFiles = 0;
  const stack = [source.root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!e.isFile() || !source.matchName(e.name)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      totalFiles += 1;
      if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
      if (st.mtimeMs < cutoffMs) continue;
      recent.push({ file: p, mtimeMs: st.mtimeMs });
    }
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { recent: recent.slice(0, MAX_FILES_PER_SOURCE), latestMtime, totalFiles };
}

/**
 * Stream a JSONL file line by line. Files larger than MAX_FILE_BYTES are tailed
 * — these logs are append-only so the newest records are at the end. A torn
 * first line is discarded.
 */
async function readLines(file: string): Promise<string[]> {
  const st = fs.statSync(file);
  const start = st.size > MAX_FILE_BYTES ? st.size - MAX_FILE_BYTES : 0;

  const stream = fs.createReadStream(file, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  let first = start > 0;
  for await (const line of rl) {
    if (first) {
      first = false; // possibly a torn line
      continue;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export interface LocalUsageResult {
  events: UsageEvent[];
  sourcesScanned: string[];
  sourcesMissing: string[];
  /** Newest file mtime per source name (ms) — shows staleness even with no recent traffic. */
  sourceLatest: Record<string, number>;
  /** Total matching files per source — informational. */
  sourceFiles: Record<string, number>;
}

/** Collect token events from every local source touched inside the lookback. */
export async function collectLocalUsage(): Promise<LocalUsageResult> {
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const events: UsageEvent[] = [];
  const sourcesScanned: string[] = [];
  const sourcesMissing: string[] = [];
  const sourceLatest: Record<string, number> = {};
  const sourceFiles: Record<string, number> = {};

  await Promise.all(
    SOURCES.map(async (source) => {
      if (!fs.existsSync(source.root)) {
        sourcesMissing.push(source.name);
        return;
      }
      const cand = findRecentFiles(source, cutoff);
      sourcesScanned.push(source.name);
      sourceLatest[source.name] = cand.latestMtime;
      sourceFiles[source.name] = cand.totalFiles;
      if (cand.recent.length === 0) return;

      let currentModel = '';
      for (const { file } of cand.recent) {
        let lines: string[];
        try {
          lines = await readLines(file);
        } catch {
          continue;
        }
        for (const line of lines) {
          let o: Record<string, unknown>;
          try {
            o = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Track the current model for sources whose token events omit it
          // (Codex puts the model on turn_context events, tokens elsewhere).
          const maybeModel =
            str(o.model) ??
            str(obj(o.payload)?.model) ??
            str(obj(obj(o.payload)?.info)?.model) ??
            str(obj(o.message)?.model);
          if (maybeModel) currentModel = maybeModel;

          const ev = source.parse(o);
          if (!ev) continue;
          const model = ev.model || currentModel || source.name;
          if (model === '<synthetic>' || model === 'synthetic') continue;
          if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite <= 0) continue;

          events.push({ ...ev, model, provider: attributeProvider(model, source.hint) });
        }
      }
    }),
  );

  return { events, sourcesScanned, sourcesMissing, sourceLatest, sourceFiles };
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------
export function emptyTally(): TokenTally {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, requests: 0 };
}

function addTo(t: TokenTally, e: UsageEvent): void {
  t.input += e.input;
  t.output += e.output;
  t.cache_read += e.cacheRead;
  t.cache_write += e.cacheWrite;
  t.total += e.input + e.output + e.cacheRead + e.cacheWrite;
  t.requests += 1;
}

export interface ModelRollup {
  provider: Provider;
  model: string;
  h1: TokenTally;
  h5: TokenTally;
  h24: TokenTally;
  lastSeen: number;
}

/** Roll events up per provider+model into 1h / 5h / 24h windows. */
export function rollup(events: UsageEvent[], now = Date.now()): ModelRollup[] {
  const H1 = now - 1 * 3600 * 1000;
  const H5 = now - 5 * 3600 * 1000;
  const H24 = now - 24 * 3600 * 1000;

  const map = new Map<string, ModelRollup>();
  for (const e of events) {
    if (e.ts < H24) continue;
    const key = `${e.provider}/${e.model}`;
    let r = map.get(key);
    if (!r) {
      r = {
        provider: e.provider,
        model: e.model,
        h1: emptyTally(),
        h5: emptyTally(),
        h24: emptyTally(),
        lastSeen: 0,
      };
      map.set(key, r);
    }
    addTo(r.h24, e);
    if (e.ts >= H5) addTo(r.h5, e);
    if (e.ts >= H1) addTo(r.h1, e);
    if (e.ts > r.lastSeen) r.lastSeen = e.ts;
  }

  return [...map.values()].sort((a, b) => b.h24.total - a.h24.total);
}
