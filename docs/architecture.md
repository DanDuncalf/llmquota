# Architecture

How data moves through the dashboard, which module owns what, and how to extend
it. For the product overview and documentation index, see
[`../README.md`](../README.md).

## Data flow

```
config/cards/*.json ─┐
data/cards/*.json  ──┴─► registry ──► scraper (60s) ──► data/state.json
                                          │
                                          └─► Express API :8787 (state + cards)
                                                   │
                                                   ├─► React UI :5173
                                                   └─► src/agent (CLI + MCP)
```

`data/state.json` is the only contract between the scraper, server and UI.
Persist the full normalized shape; the server validates it with Zod on every
read. `src/types/quota.ts` (buckets, `provider_models`, `TokenTally`,
`modelKey()`) is shared by every layer and must stay free of runtime imports.

## Project layout

```
quota-dashboard/
├── data/state.json             ← written by scraper, read by API
├── data/agent-state.json       ← one-shot scrape written by the agent layer
├── config/cards/*.json         ← card specifications (shipped)
├── data/cards/*.json           ← card specifications (yours, gitignored)
├── llmquota.cmd                ← PATH wrapper for the agent CLI
├── test/agent-smoke.mjs        ← MCP handshake + query smoke test
└── src/
    ├── env.ts                  ← tiny dependency-free .env loader (OS env wins)
    ├── types/quota.ts          ← buckets, provider_models, TokenTally, modelKey()
    ├── cards/
    │   ├── vocab.ts            ← palette names, window kinds/tiers/displays (no zod)
    │   ├── spec.ts             ← zod schema + types (one card = one spec)
    │   └── registry.ts         ← dynamic loader, mtime cache, overlay dirs, atomic CRUD
    ├── agent/
    │   ├── cli.ts              ← `llmquota` CLI (JSON or --text)
    │   ├── mcp-server.ts       ← MCP stdio server (get_quota / list_quota)
    │   ├── normalize.ts        ← compact shape + query matching + recommendation
    │   ├── providers.ts        ← provider metadata derived from the cards
    │   ├── source.ts           ← API → state.json → one-shot scrape
    │   └── config.ts           ← paths, API base, refresh policy
    ├── scraper/
    │   ├── index.ts            ← orchestrator (real default, --mock for fake)
    │   ├── collect.ts          ← scraper registry + per-card collection (daemon + API refresh)
    │   ├── cards.ts            ← declared windows ↔ measured buckets (synthesize UNAVAILABLE)
    │   ├── calculator.ts       ← pure waste-risk + routing-priority rules
    │   ├── mock-generator.ts   ← drifting mock state with the same shape as real
    │   ├── providers/          ← one scraper per provider (base.ts has shared helpers):
    │   │                         claude, chatgpt, gemini, kimi, minimax,
    │   │                         deepinfra, deepseek, qwen
    │   └── usage/
    │       ├── local-usage.ts  ← scans CLI logs → 1h/5h/24h token rollups
    │       ├── catalogs.ts     ← provider model lists (+ DeepInfra monthly)
    │       ├── deepseek-platform.ts ← day-granular platform usage
    │       └── build.ts        ← merges catalogs + rollups per provider
    ├── scripts/
    │   ├── gemini-login.ts     ← link a Google account (Antigravity OAuth)
    │   ├── cards-check.ts      ← validate cards + cross-check state.json
    │   ├── calc-check.ts
    │   └── reset-state.ts
    ├── server/
    │   ├── index.ts            ← Express + Zod validation + card CRUD
    │   └── text-render.ts      ← grouped report for curl / text clients
    └── ui/
        ├── components/ProviderCard.tsx  ← spec-driven windows + usage table
        ├── components/CardList.tsx      ← card registry (add/edit/delete)
        ├── components/CardEditor.tsx    ← card spec form
        ├── components/Dashboard.tsx     ← status panels + view switch
        ├── components/{CapacityBar,CountdownTimer}.tsx
        └── lib/{api,meta,specs,cardOrder}.ts
```

Card files: `config/cards/<id>.json` (shipped, git) and
`data/cards/<id>.json` (user, gitignored; `CARD_DIRS` can override the list).
See [`cards.md`](cards.md) for the card spec.

## Extending

- **Add a card (no code)** — drop `config/cards/<id>.json` (or use the Cards
  view / `PUT /api/cards/<id>`). Pick a palette, declare the windows, done. The
  card renders as UNAVAILABLE until a scraper reports it. See
  [`cards.md`](cards.md).
- **Give a card real numbers** — add a scraper in `src/scraper/providers/`
  returning `RawBucket[]`, then register it under the card id in `SCRAPERS` in
  `src/scraper/index.ts`. Emit `unavailableBucket({...})` on failure instead of
  fabricating numbers. Card identity, palette, labels and order stay in JSON.
- **Add a log source for token usage** — add an entry to `SOURCES` in
  `src/scraper/usage/local-usage.ts` (a `matchName` filter + a `parse`
  function), then set `usage.logs` on the card to that source name — the
  log→card mapping is derived from the registry (`build.ts`), not hardcoded.
- **Add a window to an existing card** — add it to `windows[]` with a `display`
  primitive; the scraper must emit that `model_id` or the row shows as
  UNAVAILABLE.
- **Tune thresholds** — `classifyRisk()` in `src/scraper/calculator.ts`.

See [`operations.md#verification`](operations.md#verification) for the checks to
run after card or scraper changes.
