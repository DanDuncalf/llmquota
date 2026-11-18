# AGENTS.md — Quota Dashboard

Guidance for coding agents working on this repository. This file covers only
this product.

## What this is

A local-first **LLM subscription quota dashboard**. A polling daemon scrapes
provider quota APIs and local CLI logs, normalizes everything into
`data/state.json`, and an Express API + React UI render it as one card per
subscription with a "Waste Risk Score" (expiring capacity you should burn
before falling back to pay-as-you-go).

**Cards are data, not code.** Each card is a JSON specification in
`config/cards/` (shipped) or `data/cards/` (yours, gitignored), loaded at
runtime by `src/cards/registry.ts`. Adding a card is a JSON-only operation; a
scraper is optional and only needed for real measurements.

Tracked cards and their measurement source:

| Card id | Label | Quota source |
|---|---|---|
| `anthropic` | Claude | claude.ai session cookie or Claude Code OAuth |
| `openai` | ChatGPT | Codex access token |
| `gemini` | Antigravity | Google Code Assist OAuth, one card per account |
| `moonshot` | Kimi | Kimi Code OAuth credential file (self-refreshed) or Kimi Code API key |
| `minimax` | MiniMax | MiniMax coding-plan key |
| `deepinfra` | DeepInfra | DeepInfra API key (metered spend) |
| `deepseek` | DeepSeek | DeepSeek API key (metered balance) |
| `qwen` | Qwen | No quota API; catalog + local usage only |

Data flow:

```
config/cards/*.json ─┐
data/cards/*.json  ──┴─► registry ─► scraper (60s) ─► data/state.json
                                          │
                                          └─► Express API :8787 (state + cards)
                                                   │
                                                   ├─► React UI :5173
                                                   └─► src/agent (CLI + MCP)
```

The **agent query layer** lives in `src/agent/` and is part of this package: the
`llmquota` CLI (`llmquota.cmd` → `src/agent/cli.ts`) and the stdio MCP server
(`src/agent/mcp-server.ts`, tools `get_quota` / `list_quota`). It reads the live
API first, falls back to `data/state.json`, and can spawn a one-shot scrape.

## Commands

```bash
npm install
npm run dev          # scraper (real) + API + UI
npm run dev:mock     # drifting fake data, no network, no credentials
npm run scrape -- --once   # one scrape tick then exit
npm run server       # Express API only
npm run ui           # Vite dev server only
npm run typecheck    # tsc --noEmit
npm run ui:build     # production UI build → dist-ui/
npm run reset-state  # wipe state.json and regenerate a mock snapshot
npm run cards:check  # validate card JSON + cross-check state.json
npm run gemini-login -- EMAIL   # link a Google account for Antigravity quota
npm run query -- kimi           # agent CLI (JSON; add --text for humans)
npm run mcp                     # MCP server on stdio
npm run test:agent              # MCP handshake + query smoke test
```

Verification for any non-trivial change: `npm run typecheck` must pass. For UI
changes also run `npm run ui:build`. For scraper changes, `npm run scrape:mock`
plus `curl -s http://127.0.0.1:8787/` is the quick smoke test. For card changes
run `npm run cards:check`. For changes to `src/agent/`, run
`npm run test:agent` (needs the dashboard or a fresh `data/state.json`).

## Layout

```
src/
├── env.ts                  minimal .env loader (imported first, OS env wins)
├── types/quota.ts          NormalizedQuotaBucket, Provider, TokenTally; no runtime imports
├── cards/
│   ├── vocab.ts            palette names + window kinds/tiers/displays (no zod)
│   ├── spec.ts             zod schema for one card (types + defaults)
│   └── registry.ts         dynamic loader (mtime cache), overlay dirs, atomic CRUD
├── scraper/
│   ├── index.ts            orchestrator; iterates registered cards, real by default
│   ├── collect.ts          scraper registry + per-card collection (daemon + API refresh)
│   ├── cards.ts            declared windows ↔ measured buckets (synthesize UNAVAILABLE)
│   ├── calculator.ts       pure waste-risk + routing-priority rules
│   ├── mock-generator.ts   drifting mock state with the same shape as real
│   ├── providers/          one scraper per provider (base.ts has shared helpers)
│   └── usage/              local CLI log scanning, model catalogs, rollups
├── scripts/                gemini-login, reset-state, calc-check, cards-check
├── server/                 Express API (state + card CRUD) + text renderer
└── ui/                     React + Tailwind dashboard, card list + editor
```

Card files: `config/cards/<id>.json` (shipped, git) and `data/cards/<id>.json`
(user, gitignored; `CARD_DIRS` can override the list).

## Conventions and invariants

- **`data/state.json` is the only contract** between scraper, server, and UI.
  Persist the full normalized shape; the server validates it with Zod on every
  read.
- **Never fabricate quota numbers.** When a provider has no credential, no
  active plan, or the request fails, emit `unavailableBucket({ reason })` so the
  card renders UNAVAILABLE with an explanation.
- **Keep `src/types/quota.ts` free of runtime imports** so it can be shared by
  every layer.
- **Provider scrapers are pure data producers**: return `RawBucket[]` and let
  `enrichBucket()` in `calculator.ts` fill `waste_risk`, `routing_priority`, and
  `waste_score`. Risk thresholds live only in `calculator.ts`.
- **Agent-triggered scrapes must never write `data/state.json`.** The daemon
  owns that file. `refreshState()` spawns `src/scraper/index.ts --once` with
  `SCRAPE_OUT=data/agent-state.json` and reads its own snapshot back. An agent
  process can run with a narrower environment (e.g. Codex-spawned MCP servers
  without provider keys), so clobbering the daemon's fresher snapshot produces a
  dashboard full of bogus UNAVAILABLE cards until the next tick. The scraper's
  `--out=PATH` / `SCRAPE_OUT` is the supported way for any out-of-band caller
  to write elsewhere.
- **`src/agent/` never re-derives quota numbers.** It only reshapes
  `data/state.json` (or the API copy of it) for agents. Anything computed there
  must already exist in the state file.
- **Keep the agent layer's JSON shape stable.** `get_quota` / `list_quota` and
  the CLI are consumed by orchestration scripts (e.g. mogcrew's
  `core-dispatch.py`) and by agent prompts; rename fields only with a repo-wide
  reference sweep. The MCP entry is registered in `~/.codex/config.toml` as
  `[mcp_servers.llmquota]` and launches `node_modules/tsx/dist/cli.mjs
  src/agent/mcp-server.ts` — keep that command working.
- **Tests for the agent layer are live-data smoke tests**
  (`test/agent-smoke.mjs`). They assert specific providers/accounts exist on
  this machine; treat a failure as "check the dashboard state" before assuming
  a code regression.
- **Label quota windows by duration, not position.** ChatGPT plans differ:
  `primary_window` may be the 7-day window. Derive labels from
  `limit_window_seconds`.
- **Claude's usage endpoint rate-limits (429).** `claude.ts` keeps the last
  good payload in `data/claude-usage-cache.json`, reuses it with a `cached …`
  row label, polls at most every `CLAUDE_MIN_FETCH_INTERVAL_MS` (5 min), and
  backs off `CLAUDE_RATE_LIMIT_BACKOFF_MS` (10 min) after a 429. Do not remove
  this and go back to "one failed fetch = UNAVAILABLE".
- **Do not replace the Claude web fetch's `curl` call with Node `fetch`** —
  claude.ai's Cloudflare protection rejects Node's TLS fingerprint.
- **Currency units differ.** Kimi's backup wallet is reported in micro-cents
  (`amount / 1e8`). DeepInfra reports monthly spend, not token usage.
- **Kimi's credential outlives the session.** `KIMI_API_KEY` only exists inside
  a live Kimi Code session, so the scraper falls back to the CLI's OAuth file
  (`kimi.ts` tries `$KIMI_CODE_HOME`, `~/.kimi-code`, `~/.kimi` — some slots
  are emptied migration leftovers, so content is checked, not just existence).
  The stored access token is itself a valid Bearer for the usages endpoint;
  when expired the scraper refreshes it via `auth.kimi.com/api/oauth/token`
  and writes the rotated pair back atomically, lock-file guarded, same as the
  Claude scraper.
- **Adding a card is a JSON edit, not a code change.** Drop
  `config/cards/<id>.json` (or use the Cards view / `PUT /api/cards/<id>`).
  The registry is the single source of identity: label, palette, console URL,
  order, aliases, declared windows. Do not reintroduce provider-id unions or
  `Record<Provider, …>` tables — `Provider` is deliberately `string` so runtime
  cards type-check. A single card can be re-scraped on demand via
  `POST /api/cards/<id>/refresh`, which merges fresh buckets into `state.json`
  (buckets only — usage tables refresh on the next full tick).
- **A card with no scraper still renders.** `collectCardBuckets()` in
  `src/scraper/index.ts` synthesizes one UNAVAILABLE bucket per declared window
  ("no scraper registered"). To give a card real numbers, add a scraper in
  `src/scraper/providers/` and register it in `SCRAPERS` under the card id.
- **Declared windows are a promise.** `reconcileCardWindows()`
  (`src/scraper/cards.ts`) turns a missing measurement into an UNAVAILABLE row
  rather than dropping it. It is skipped when the scraper already returned any
  unavailable bucket — that bucket is the card explaining itself.
- **`shown: false` means "hidden template, not capacity".** The shipped library
  has 36 hidden templates (Grok, Gemini AI Studio, Mistral, Cursor, Groq,
  OpenRouter, Azure, Bedrock, Ollama, …). Hidden cards must be excluded from:
  the scraper (`collectCardBuckets`), mock generation, catalog/usage build, the
  dashboard grid, `buildResponse()` summary numbers, the text renderer, and
  `cards_without_data`. They still appear in `GET /api/cards` and the Cards view
  so they can be shown. When adding a new "provider", add the card JSON with
  `"shown": false` unless it is meant to be live by default. The card field was
  formerly `enabled`; the zod schema still accepts it as a legacy alias.
- **Card ids are join keys** with `state.json` `provider`, the JSON filename,
  and the UI's saved drag order (`cardKey()`). Treat them as append-only.
- **Palette classes must stay in `src/ui/lib/meta.ts`.** Cards store a palette
  *name*; Tailwind only scans `.ts/.tsx` sources, so class strings loaded from
  JSON would never reach the CSS bundle.
- **Card JSON is validated with zod at load time (`src/cards/spec.ts`), not by
  `tsc`.** One bad file must never take the dashboard down: the loader reports
  `{file, message}` in `GET /api/cards` and `/api/health`, and keeps the previous
  good version of that card. Run `npm run cards:check` before committing.
- **`types/quota.ts` must not import `src/cards/`** (which pulls in zod); the
  browser gets specs over HTTP, types only.
- **DeepSeek token usage is day-granular.** It comes from
  `platform.deepseek.com/api/v0/usage/amount`, authenticated with the browser
  session token `DEEPSEEK_PLATFORM_TOKEN` (not the `sk-` API key). Only the
  24h column is populated (meaning today so far); 1h/5h stay empty. If the
  token expires, the card keeps showing the balance and the note explains why.
- **Adding a usage log source** means one entry in `SOURCES` in
  `src/scraper/usage/local-usage.ts` (`matchName` + `parse`), then set
  `usage.logs` on the card(s) it feeds — the log→card mapping is derived from
  the registry (`build.ts`), not hardcoded.
- UI is React 18 function components + Tailwind. No state library; small
  helpers live in `src/ui/lib/` (`specs.ts` for card lookups/ordering,
  `meta.ts` for palettes and status chips). The Cards view is
  `components/CardList.tsx` + `components/CardEditor.tsx`.
- Keep comments explaining *why* (provider quirks, endpoint behavior), matching
  the existing dense-header style.

## Running as a Windows service (this machine)

The dashboard is registered as a hidden logon task so it outlives terminals and
agent sessions:

- Task: **`LLM Quota Dashboard`** — trigger AtLogOn for the current user.
- Action: `wscript.exe scripts/start-service.vbs` → `scripts/run-service.cmd` →
  `npm run dev`, logging to `data/service.log`.
- Register or refresh the task:
  `powershell -ExecutionPolicy Bypass -File scripts/register-startup-task.ps1`
- Start/stop: `Start-ScheduledTask -TaskName 'LLM Quota Dashboard'` /
  `scripts\stop-service.cmd` (stops the task and kills the npm/node tree —
  stopping the task alone leaves the children running).
- `run-service.cmd` refuses to start if `:8787` is already listening.

## Secrets and credentials

- `.env` is gitignored and must stay that way. `.env.example` contains only
  blank placeholders — never add real values to it.
- Credentials are read from the OS environment first, then `.env`, and from
  local credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`,
  `~/.gemini-profiles/*/.gemini/oauth_creds.json`, `~/.qwen/settings.json`,
  `~/.kimi*/credentials/kimi-code.json`). Treat these as read-only unless the
  task explicitly is about credential refresh.
- Never commit `data/state.json`; it can contain account emails and usage data.
- `npm run gemini-login` needs `ANTIGRAVITY_OAUTH_CLIENT_SECRET` (or
  `GEMINI_OAUTH_CLIENT_SECRET` with `--gemini`) in the environment or `.env`.
  Those installed-app client secrets are deliberately not in the repo because
  GitHub secret scanning blocks them — do not hardcode them back.
- Before committing, scan for tokens/keys/PII, e.g.:
  `grep -rniE "sk-ant|sk-kimi|sk-cp|gho_|ghp_|github_pat|sessionKey=" . --exclude-dir=node_modules`
- Provider endpoints used here are internal/undocumented. Changes can break
  scraping without a code change; surface failures as `unavailable` rather than
  throwing out of the daemon loop.
