# Agent query layer (CLI + MCP)

The dashboard ships its own agent-facing query layer in `src/agent/` — the
`llmquota` CLI and a stdio MCP server. Both read the live API first, fall back
to `data/state.json`, and can run a one-shot scrape when the snapshot is stale.
Nothing leaves this checkout; there is no second project to install. For the
product overview and documentation index, see [`../README.md`](../README.md).

| Field in the JSON | Meaning |
|---|---|
| `dollars_left` | prepaid USD balance (DeepSeek; DeepInfra is postpaid so it reports `dollars_spent`) |
| `five_hour` | 5-hour session window: `used_pct`, `remaining_pct`, `resets_at`, `reset_in` |
| `weekly` | weekly window: same shape |
| `windows` | metered / other windows (and unavailable-plan placeholders) |
| `models` | per-model token usage over rolling 1 h / 5 h / 24 h |
| `recommended_next` | the plan window whose capacity expires soonest |

Queries work by **company** (`claude`, `openai`, `gemini`/`agy`, `kimi`,
`deepseek`, …), by **model** (`gpt-6.1-sol`, `gemini-3.8-flash-high`,
`kimi-for-coding`, …), or by **account** (`you@example.com`,
`second@example.com`) for the multi-account Agy harness.

```bash
llmquota.cmd kimi                  # JSON (add E:\path\to\llmquota to PATH → llmquota)
llmquota.cmd deepseek              # JSON with dollars_left
llmquota.cmd gpt-6.1-sol           # JSON via model -> provider
llmquota.cmd agy                   # both linked Gemini/Agy accounts
llmquota.cmd you@example.com       # one Agy account by email/local-part
llmquota.cmd --list --refresh      # every provider, fresh scrape
llmquota.cmd openai --text         # human-readable
```

Text mode:

```
LLM utilization — snapshot 3s old
query: openai (matched by provider)

ChatGPT (OpenAI)  [available]
  5h session   used     6%  left    94%  resets in 4h 44m
  weekly       used    17%  left    83%  resets in 6d 9h
  models (24h tokens):
    gpt-6.1-sol                           107822891  311 reqs

next: Kimi 5h session — 75.4% left, resets in 1h 54m
```

## MCP tools

| Tool | Arguments | Returns |
|---|---|---|
| `get_quota` | `query` (company, model, or account), optional `refresh`, optional `include_models` | compact JSON payload |
| `list_quota` | optional `refresh` | every provider, compact |

Gemini via the **Agy harness** is reported once per linked Google account. Each
entry has `provider: "gemini"`, `harness: "agy"`, and an `account` email; query
`gemini` / `agy` / `antigravity` for both accounts, or `you@example.com` for one.

`refresh`:

* omitted → auto: scrape if the snapshot is older than `LLMQUOTA_MAX_AGE_SEC` (300 s)
* `true` → always scrape (~2 s, hits provider APIs)
* `false` → never scrape; serve the snapshot as-is

MCP servers log to **stderr** only; stdout is the protocol channel.

## Register it

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.llmquota]
command = 'C:\Program Files\nodejs\node.exe'
args = ['E:\path\to\llmquota\node_modules\tsx\dist\cli.mjs', 'E:\path\to\llmquota\src\agent\mcp-server.ts']
```

**Kimi CLI**

```bash
kimi mcp add llmquota -- node E:\path\to\llmquota\node_modules\tsx\dist\cli.mjs E:\path\to\llmquota\src\agent\mcp-server.ts
kimi mcp list
```

**Claude Code**

```bash
claude mcp add llmquota -- node E:\path\to\llmquota\node_modules\tsx\dist\cli.mjs E:\path\to\llmquota\src\agent\mcp-server.ts
```

**Any JSON-config client** (`mcpServers` block):

```json
{
  "mcpServers": {
    "llmquota": {
      "command": "node",
      "args": [
        "E:\\path\\to\\llmquota\\node_modules\\tsx\\dist\\cli.mjs",
        "E:\\path\\to\\llmquota\\src\\agent\\mcp-server.ts"
      ]
    }
  }
}
```

## Data freshness and failure behavior

`data/state.json` belongs to the scraper daemon. When the agent CLI/MCP needs
fresher data it runs a one-shot scrape that writes **`data/agent-state.json`**
(`SCRAPE_OUT`) and reads that file back — so an agent running without provider
credentials can never overwrite the dashboard's snapshot. Any other out-of-band
caller can do the same with `npm run scrape -- --once --out=PATH`.

Resolution order on every call:

1. `GET http://127.0.0.1:8787/api/quota-state` (dashboard running)
2. `data/state.json` (dashboard stopped — still works, but ages)
3. one-shot `tsx src/scraper/index.ts --once` when stale and refresh is allowed

If a scrape fails, the tool still returns the last snapshot and appends a
`refresh failed: …` warning. A missing/unreadable state file returns `ok: false`
with a hint.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `LLMQUOTA_STATE` | `<repo>/data/state.json` | explicit snapshot path |
| `LLMQUOTA_AGENT_STATE` | `<repo>/data/agent-state.json` | snapshot written and read back by one-shot agent scrapes |
| `LLMQUOTA_API` | `http://127.0.0.1:8787` | dashboard API base |
| `LLMQUOTA_AUTO_REFRESH` | `1` | `0` disables implicit scrapes |
| `LLMQUOTA_MAX_AGE_SEC` | `300` | staleness threshold for auto-refresh |
| `LLMQUOTA_REFRESH_TIMEOUT_MS` | `90000` | scrape timeout |

`npm run test:agent` spawns the real MCP server over stdio, lists tools, and
queries a company (`kimi`), a model (`gpt-6.1-sol`), a prepaid balance
(`deepseek`), both Agy accounts, plus an unknown query. It is a live-data smoke
test: a failure usually means "check the dashboard state" before assuming a code
regression.
