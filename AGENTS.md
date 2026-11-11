# AGENTS.md — Quota Dashboard

Guidance for coding agents working on this repository. This file covers only
this product.

## What this is

A local-first **LLM subscription quota dashboard**. A polling daemon scrapes
provider quota APIs and local CLI logs, normalizes everything into
`data/state.json`, and an Express API + React UI render it as one card per
subscription with a "Waste Risk Score" (expiring capacity you should burn
before falling back to pay-as-you-go).

Tracked providers and internal ids:

| Product name | `Provider` id | Quota source |
|---|---|---|
| Claude | `anthropic` | claude.ai session cookie or Claude Code OAuth |
| ChatGPT / Codex | `openai` | Codex access token |
| Antigravity (Gemini) | `gemini` | Google Code Assist OAuth, one card per account |
| Kimi | `moonshot` | Kimi Code API key |
| MiniMax | `minimax` | MiniMax coding-plan key |
| DeepInfra | `deepinfra` | DeepInfra API key (metered spend) |
| DeepSeek | `deepseek` | DeepSeek API key (metered balance) |
| Qwen | `qwen` | No quota API; catalog + local usage only |

Data flow:

```
scraper daemon (60s) ──► data/state.json ──► Express API :8787 ──► React UI :5173
```

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
npm run gemini-login -- EMAIL   # link a Google account for Antigravity quota
```

Verification for any non-trivial change: `npm run typecheck` must pass. For UI
changes also run `npm run ui:build`. For scraper changes, `npm run scrape:mock`
plus `curl -s http://127.0.0.1:8787/` is the quick smoke test.

## Layout

```
src/
├── env.ts                  minimal .env loader (imported first, OS env wins)
├── types/quota.ts          NormalizedQuotaBucket, Provider, TokenTally; no runtime imports
├── scraper/
│   ├── index.ts            orchestrator; real by default, --mock for fake
│   ├── calculator.ts       pure waste-risk + routing-priority rules
│   ├── mock-generator.ts   drifting mock state with the same shape as real
│   ├── providers/          one scraper per provider (base.ts has shared helpers)
│   └── usage/              local CLI log scanning, model catalogs, rollups
├── scripts/                gemini-login, reset-state, calc-check
├── server/                 Express API + text renderer
└── ui/                     React + Tailwind dashboard
```

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
- **Adding a provider** touches: a scraper in `src/scraper/providers/`, the
  registration in `src/scraper/index.ts`, `Provider` + `PROVIDER_ORDER` +
  `PROVIDER_LABEL` in `src/types/quota.ts`, the Zod enum in
  `src/server/index.ts`, `PROVIDER_META` in `src/ui/lib/meta.ts`, and the docs
  in `README.md`.
- **DeepSeek token usage is day-granular.** It comes from
  `platform.deepseek.com/api/v0/usage/amount`, authenticated with the browser
  session token `DEEPSEEK_PLATFORM_TOKEN` (not the `sk-` API key). Only the
  24h column is populated (meaning today so far); 1h/5h stay empty. If the
  token expires, the card keeps showing the balance and the note explains why.
- **Adding a usage log source** means one entry in `SOURCES` in
  `src/scraper/usage/local-usage.ts` (`matchName` + `parse`).
- UI is React 18 function components + Tailwind. No state library; small
  helpers live in `src/ui/lib/`.
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
  `~/.gemini-profiles/*/.gemini/oauth_creds.json`, `~/.qwen/settings.json`).
  Treat these as read-only unless the task explicitly is about credential
  refresh.
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
