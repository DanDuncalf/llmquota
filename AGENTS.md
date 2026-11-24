# AGENTS.md — Quota Dashboard

Agent-facing conventions for this repository. **Start with
[`README.md`](README.md)** for the product overview and the documentation index;
its index links the architecture, cards, setup, usage, API, agent and operations
docs. This file covers only the rules an agent must not break, linking to the
relevant doc when detail matters.

## Verification

`npm run typecheck` must pass for any non-trivial change. The per-area checks
(UI build, mock scrape smoke test, `cards:check`, `test:agent`) are listed in
[`docs/operations.md#verification`](docs/operations.md#verification).

## Invariants

### Data contract

- **`data/state.json` is the only contract** between scraper, server and UI.
  Persist the full normalized shape; the server validates it with Zod on every
  read.
- **Never fabricate quota numbers.** When a provider has no credential, no
  active plan, or the request fails, emit `unavailableBucket({ reason })` so the
  card renders UNAVAILABLE with an explanation. Provider endpoints are
  internal/undocumented: surface failures as `unavailable` rather than throwing
  out of the daemon loop.
- **Keep `src/types/quota.ts` free of runtime imports** so every layer can share
  it. It must **not** import `src/cards/` (which pulls in zod); the browser gets
  specs over HTTP, types only.
- **Provider scrapers are pure data producers**: return `RawBucket[]` and let
  `enrichBucket()` in `calculator.ts` fill `waste_risk`, `routing_priority` and
  `waste_score`. Risk thresholds live only in `calculator.ts`.

### Agent layer

- **Agent-triggered scrapes must never write `data/state.json`.** The daemon
  owns that file. `refreshState()` spawns `src/scraper/index.ts --once` with
  `SCRAPE_OUT=data/agent-state.json` and reads its own snapshot back. An agent
  process can run with a narrower environment (e.g. Codex-spawned MCP servers
  without provider keys), so clobbering the daemon's fresher snapshot produces a
  dashboard full of bogus UNAVAILABLE cards until the next tick. `--out=PATH` /
  `SCRAPE_OUT` is the supported escape hatch for any out-of-band caller.
- **`src/agent/` never re-derives quota numbers.** It only reshapes
  `data/state.json` (or the API copy of it) for agents. Anything computed there
  must already exist in the state file.
- **Keep the agent layer's JSON shape stable.** `get_quota` / `list_quota` and
  the CLI are consumed by orchestration scripts (e.g. mogcrew's
  `core-dispatch.py`) and by agent prompts; rename fields only with a repo-wide
  reference sweep. The MCP entry is registered in `~/.codex/config.toml` as
  `[mcp_servers.llmquota]` and launches `node_modules/tsx/dist/cli.mjs
  src/agent/mcp-server.ts` — keep that command working. Details:
  [`docs/agent.md`](docs/agent.md).
- **Tests for the agent layer are live-data smoke tests**
  (`test/agent-smoke.mjs`). They assert specific providers/accounts exist on
  this machine; treat a failure as "check the dashboard state" before assuming
  a code regression.

### Provider quirks that must not regress

- **Claude's usage endpoint rate-limits (429).** Keep the cache/poll/backoff
  behavior in `claude.ts` (see
  [`docs/setup.md#claude--needs-one-manual-step`](docs/setup.md#claude--needs-one-manual-step)).
  Do not go back to "one failed fetch = UNAVAILABLE".
- **Do not replace the Claude web fetch's `curl` call with Node `fetch`** —
  claude.ai's Cloudflare protection rejects Node's TLS fingerprint.
- **Label quota windows by duration, not position.** Derive labels from
  `limit_window_seconds`; `primary_window` may be the 7-day window. See
  [`docs/setup.md#chatgpt--codex-tokens-expire-and-rotate`](docs/setup.md#chatgpt--codex-tokens-expire-and-rotate).
- **Kimi's credential outlives the session.** `KIMI_API_KEY` only exists inside
  a live Kimi Code session, so keep the OAuth-file fallback and self-refresh in
  `kimi.ts`. See [`docs/setup.md#kimi--plan-windows--backup-balance`](docs/setup.md#kimi--plan-windows--backup-balance).
- **Currency units differ.** Kimi's backup wallet is micro-cents
  (`amount / 1e8`). DeepInfra reports monthly spend, not token usage.
- **DeepSeek token usage is day-granular** — see
  [`docs/usage.md`](docs/usage.md).
- **Adding a usage log source** is an entry in `SOURCES`
  (`src/scraper/usage/local-usage.ts`) plus `usage.logs` on the card. Never
  hardcode the log→card mapping outside `build.ts`; see
  [`docs/architecture.md#extending`](docs/architecture.md#extending).

### Cards

- **Adding a card is a JSON edit, not a code change.** Drop
  `config/cards/<id>.json` (or use the Cards view / `PUT /api/cards/<id>`).
  The registry is the single source of identity: label, palette, console URL,
  order, aliases, declared windows. Do not reintroduce provider-id unions or
  `Record<Provider, …>` tables — `Provider` is deliberately `string` so runtime
  cards type-check. Spec: [`docs/cards.md`](docs/cards.md).
- **A card with no scraper still renders.** `collectCardBuckets()` in
  `src/scraper/index.ts` synthesizes one UNAVAILABLE bucket per declared window
  ("no scraper registered"). To give a card real numbers, add a scraper in
  `src/scraper/providers/` and register it in `SCRAPERS` under the card id.
- **Declared windows are a promise.** `reconcileCardWindows()`
  (`src/scraper/cards.ts`) turns a missing measurement into an UNAVAILABLE row
  rather than dropping it. It is skipped when the scraper already returned any
  unavailable bucket — that bucket is the card explaining itself.
- **`shown: false` means "hidden template, not capacity".** Hidden cards must
  be excluded from the scraper (`collectCardBuckets`), mock generation,
  catalog/usage build, the dashboard grid, `buildResponse()` summary numbers,
  the text renderer and `cards_without_data`. They still appear in
  `GET /api/cards` and the Cards view so they can be shown. A new provider card
  defaults to `"shown": false` unless it is meant to be live. The zod schema
  still accepts the legacy `enabled` field.
- **Card ids are join keys** with `state.json` `provider`, the JSON filename and
  the UI's saved drag order (`cardKey()`). Treat them as append-only.
- **Palette classes must stay in `src/ui/lib/meta.ts`.** Cards store a palette
  *name*; Tailwind only scans `.ts/.tsx` sources, so class strings loaded from
  JSON would never reach the CSS bundle.
- **Card JSON is validated with zod at load time (`src/cards/spec.ts`), not by
  `tsc`.** One bad file must never take the dashboard down: the loader reports
  `{file, message}` in `GET /api/cards` and `/api/health`, and keeps the previous
  good version of that card. Run `npm run cards:check` before committing.
- Single-card refresh is `POST /api/cards/<id>/refresh`; its merge semantics are
  documented in [`docs/api.md#card-api`](docs/api.md#card-api).

### UI

- React 18 function components + Tailwind. No state library; small helpers live
  in `src/ui/lib/` (`specs.ts` for card lookups/ordering, `meta.ts` for palettes
  and status chips). The Cards view is `components/CardList.tsx` +
  `components/CardEditor.tsx`.
- Keep comments explaining *why* (provider quirks, endpoint behavior), matching
  the existing dense-header style.

## This machine and secrets

- The dashboard runs as a hidden Windows logon task; see
  [`docs/operations.md#windows-logon-task-this-machine`](docs/operations.md#windows-logon-task-this-machine).
- Credential handling, credential-file etiquette and the pre-commit secret scan
  are documented in [`docs/setup.md#secrets`](docs/setup.md#secrets). Never
  commit `data/state.json` (it can contain account emails and usage data).
