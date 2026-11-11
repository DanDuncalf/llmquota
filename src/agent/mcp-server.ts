#!/usr/bin/env node
// =============================================================================
// MCP server — llmquota
// =============================================================================
// stdio MCP server exposing the local multi-LLM quota snapshot to any agent.
//
// Tools:
//   get_quota(query)   — by company name, model name, or account
//   list_quota()       — every provider, compact
//
// Data comes from this checkout's state file/API; a one-shot scrape is run when
// the snapshot is older than LLMQUOTA_MAX_AGE_SEC (default 300s).
// =============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadState } from './source.js';
import { queryState, listState } from './normalize.js';
import type { ListPayload, QueryPayload } from './normalize.js';
import type { LoadedState } from './source.js';

type Payload = QueryPayload | ListPayload;

const server = new McpServer({
  name: 'llmquota',
  version: '1.0.0',
});

function finish(payload: Payload, loaded: LoadedState) {
  payload.data.source = loaded.source;
  payload.data.refreshed = loaded.refreshed;
  if (loaded.refresh_error) payload.warnings.push(`refresh failed: ${loaded.refresh_error}`);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function failure(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            hint:
              'Check that the llmquota checkout exists and has node_modules installed, and, for fresh data, that the dashboard is running on 127.0.0.1:8787.',
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

server.registerTool(
  'get_quota',
  {
    title: 'Get LLM quota',
    description:
      'Check how much LLM capacity or credit is left before starting (or continuing) a task. ' +
      'Query by company name (claude, openai/chatgpt, gemini/agy/antigravity, kimi, minimax, deepinfra, deepseek, qwen), ' +
      'by model name (e.g. "gpt-6.1-sol", "gemini-3.8-flash-high", "kimi-for-coding"), ' +
      'or by account email/local-part (e.g. "you@example.com") for the multi-account Agy harness. ' +
      'Returns JSON containing dollars_left (prepaid balance), five_hour and weekly windows ' +
      '(used_pct, remaining_pct, resets_at, reset_in), per-model token usage, and which ' +
      'provider/window should be used next.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          'Company ("claude", "openai", "gemini", "agy", "kimi"), model ("gpt-6.1-sol", "gemini-3.8-flash-high"), or account email/local-part ("you@example.com").',
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          'Force a fresh scrape from the providers before answering. Default: automatic when the snapshot is older than 5 minutes.',
        ),
      include_models: z
        .boolean()
        .optional()
        .describe('Include per-model 1h/5h/24h token usage (default true).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, refresh, include_models }) => {
    try {
      const loaded = await loadState({ refresh });
      const payload = queryState(loaded.state, query, { includeModels: include_models !== false });
      return finish(payload, loaded);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'list_quota',
  {
    title: 'List LLM quota',
    description:
      'List every configured LLM provider with its remaining 5-hour/weekly quota and prepaid dollar balance. ' +
      'Gemini via the Agy harness appears once per linked Google account. ' +
      'Use when you do not know which provider, account, or model name to ask for.',
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe('Force a fresh scrape before answering (default: auto when stale).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ refresh }) => {
    try {
      const loaded = await loadState({ refresh });
      return finish(listState(loaded.state), loaded);
    } catch (err) {
      return failure(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr only — stdout is the MCP channel.
console.error('[llmquota] MCP server ready (stdio)');
