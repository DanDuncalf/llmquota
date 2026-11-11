#!/usr/bin/env node
// =============================================================================
// llmquota — command line query for the local multi-LLM quota dashboard
// =============================================================================
//   llmquota claude                 JSON for one company
//   llmquota kimi-for-coding        JSON for whichever provider serves a model
//   llmquota --list                 every provider, compact
//   llmquota openai --text          human-readable instead of JSON
//   llmquota openai --refresh       force a fresh scrape first
//
// Exit codes: 0 ok, 1 error, 2 bad usage.
// =============================================================================

import { loadState } from './source.js';
import { queryState, listState } from './normalize.js';
import type { ListPayload, NormalizedWindow, QueryPayload } from './normalize.js';

interface Options {
  list: boolean;
  text: boolean;
  refresh: boolean | undefined;
  models: boolean;
  help: boolean;
  words: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    list: false,
    text: false,
    refresh: undefined,
    models: true,
    help: false,
    words: [],
  };
  for (const arg of argv) {
    switch (arg) {
      case '--list':
      case '-l':
      case '--all':
        opts.list = true;
        break;
      case '--text':
      case '--plain':
        opts.text = true;
        break;
      case '--json':
        opts.text = false;
        break;
      case '--refresh':
        opts.refresh = true;
        break;
      case '--no-refresh':
        opts.refresh = false;
        break;
      case '--no-models':
        opts.models = false;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`unknown flag: ${arg}`);
          process.exit(2);
        }
        opts.words.push(arg);
    }
  }
  return opts;
}

function pctLine(label: string, w: NormalizedWindow): string {
  if (w.kind === 'metered') {
    if (w.dollars_left != null) return `  ${label.padEnd(12)} $${w.dollars_left.toFixed(2)} left`;
    if (w.dollars_spent != null) {
      return `  ${label.padEnd(12)} $${w.dollars_spent.toFixed(2)} spent (${w.spend_period ?? 'current period'})`;
    }
    return `  ${label.padEnd(12)} ${w.notes ?? 'metered'}`;
  }
  if (!w.available) return `  ${label.padEnd(12)} UNAVAILABLE — ${w.unavailable_reason ?? 'unknown'}`;
  return (
    `  ${label.padEnd(12)} used ${String(w.used_pct).padStart(5)}%` +
    `  left ${String(w.remaining_pct).padStart(5)}%` +
    `  resets in ${w.reset_in}`
  );
}

function renderText(payload: QueryPayload | ListPayload, listMode: boolean): string {
  const lines: string[] = [];
  const age = payload.data.age ?? 'unknown';
  lines.push(`LLM utilization — snapshot ${age} old` + (payload.data.stale ? ' (STALE)' : ''));
  if ('query' in payload && payload.query) {
    lines.push(`query: ${payload.query} (matched by ${payload.matched_by ?? 'nothing'})`);
  }
  lines.push('');

  for (const p of payload.providers) {
    lines.push(`${p.display_name} (${p.company})  [${p.status}]`);
    const rows: string[] = [];
    if (p.five_hour) rows.push(pctLine('5h session', p.five_hour));
    if (p.weekly) rows.push(pctLine('weekly', p.weekly));
    for (const w of p.windows) {
      if (w === p.five_hour || w === p.weekly) continue;
      rows.push(pctLine(w.label, w));
    }
    for (const row of rows) lines.push(row);
    if (p.unavailable_reason && !p.windows.some((w) => !w.available)) {
      lines.push(`  UNAVAILABLE — ${p.unavailable_reason}`);
    }
    if (!listMode && p.models.length) {
      lines.push('  models (24h tokens):');
      for (const m of p.models) {
        // Query payloads carry per-window tallies; list payloads carry h24_*.
        const t = 'tokens' in m ? m.tokens?.h24 : null;
        const total = 'h24_total' in m ? m.h24_total : (t?.total ?? 0);
        const reqs = 'h24_requests' in m ? m.h24_requests : (t?.requests ?? 0);
        lines.push(`    ${m.model.padEnd(34)} ${String(total).padStart(12)}  ${reqs} reqs`);
      }
    }
    lines.push('');
  }

  if (payload.providers.length === 0) {
    lines.push('no matches');
    for (const w of payload.warnings) lines.push(`  ${w}`);
    lines.push('');
  }

  if (payload.recommended_next) {
    const r = payload.recommended_next;
    lines.push(
      `next: ${r.display_name} ${r.window} — ${r.remaining_pct}% left, resets in ${r.reset_in}`,
    );
  }
  for (const w of payload.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n').trimEnd();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      [
        'usage: llmquota <company|model> [--text] [--refresh|--no-refresh] [--no-models]',
        '       llmquota --list',
        '',
        'examples:',
        '  llmquota claude',
        '  llmquota gpt-6.1-sol',
        '  llmquota kimi --text',
        '  llmquota --list --refresh',
        '',
        'env:',
        '  LLMQUOTA_STATE              explicit state.json path',
        '  LLMQUOTA_API                dashboard API base (default http://127.0.0.1:8787)',
        '  LLMQUOTA_AUTO_REFRESH       set 0 to disable implicit scrapes',
        '  LLMQUOTA_MAX_AGE_SEC        staleness threshold for auto-refresh (default 300)',
        '  LLMQUOTA_REFRESH_TIMEOUT_MS hard limit for a one-shot scrape (default 90000)',
      ].join('\n'),
    );
    return;
  }

  const query = opts.words.join(' ').trim();
  if (!opts.list && !query) {
    console.error('usage: llmquota <company|model> [--list] [--text] [--refresh]  (see --help)');
    process.exit(2);
  }

  const loaded = await loadState({ refresh: opts.refresh });
  const payload = opts.list
    ? listState(loaded.state)
    : queryState(loaded.state, query, { includeModels: opts.models });

  payload.data.source = loaded.source;
  payload.data.refreshed = loaded.refreshed;
  if (loaded.refresh_error) payload.warnings.push(`refresh failed: ${loaded.refresh_error}`);

  process.stdout.write(
    opts.text ? `${renderText(payload, opts.list)}\n` : `${JSON.stringify(payload, null, 2)}\n`,
  );
  if (loaded.refresh_error && opts.refresh === true) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`llmquota: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
