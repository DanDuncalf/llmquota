# Quota Dashboard — Multi-LLM Fleet

A local-first web dashboard + polling daemon that tracks your **real** LLM
subscription quotas across **Claude, ChatGPT (Codex), Gemini CLI, Kimi, MiniMax,
DeepInfra, DeepSeek and Qwen**, normalizes their rolling / weekly / metered
windows into a single shape, and computes a **Waste Risk Score** so you burn
expiring free capacity before falling back to pay-as-you-go.

It also reports **per-model token usage** over rolling **1h / 5h / 24h** windows
read from your local CLI logs, and lists **every model each provider offers**.

```
┌──────────────────────────────────────────────────────────────────────┐
│  scraper daemon (60s)  ──►  data/state.json  ──►  Express API :8787  │
│    ├─ provider quota APIs                                            │
│    ├─ provider model catalogs                                       │
│    └─ local CLI logs (token usage)                                   │
│                                        │                             │
│                                        ▼                             │
│                          React Dashboard :5173                       │
└──────────────────────────────────────────────────────────────────────┘
```

## What it shows

### 1. Status panels that name providers

Each status lists **which providers** are behind it — not just a count:

```
PROVIDERS    Claude, ChatGPT, Antigravity, Kimi, MiniMax, DeepInfra, DeepSeek, Qwen
CRITICAL     ChatGPT
HIGH         Kimi
COOLDOWN     —
METERED      DeepInfra, DeepSeek
UNAVAILABLE  Claude, MiniMax, Qwen
```

### 2. One card per subscription, one row per quota window

```
CLAUDE  (anthropic)                          [UNAVAILABLE]
  plan windows    UNAVAILABLE  no Claude credential — set CLAUDE_SESSION_KEY …

CHATGPT  (openai)                   2 windows           [CRITICAL]
  5h session      CRITICAL     0.0% [----------]   5h 0m   Plus plan · 3 banked resets  ★ NEXT
  Weekly          MODERATE     0.0% [----------]   7d 0h   Plus plan
  usage-limit resets: 3 available
    Full reset (Weekly + 5 hr)     expires 2026-10-22 (in 3d 2h)
    Full reset (Weekly + 5 hr)     expires 2026-10-29 (in 10d 0h)
    Full reset (Weekly + 5 hr)     expires 2026-11-06 (in 18d 3h)

ANTIGRAVITY · you@example.com  (gemini)             2 windows   [MODERATE]
  Gemini · Weekly   MODERATE   16.8% [##--------]  6d 22h  Antigravity Starter Quota  ★ NEXT
  Claude · Weekly   MODERATE    1.1% [----------]  6d 23h  Antigravity Starter Quota

ANTIGRAVITY · second@example.com  (gemini)          2 windows   [MODERATE]
  Claude · Weekly   MODERATE    0.0% [----------]  7d 0h   Antigravity Starter Quota
  Gemini · Weekly   MODERATE    0.0% [----------]  7d 0h   Antigravity Starter Quota

KIMI  (moonshot)                    3 windows           [HIGH]
  5h session      HIGH        45.1% [#####-----]   1h 24m  Kimi Code Plan
  Weekly          MODERATE    17.7% [##--------]   2d 22h  Kimi Code Plan
  backup balance  METERED     $487.30 balance · $1,000.00 reserved · $5.13 used 2026-10

DEEPINFRA  (deepinfra)              1 window            [METERED]
  metered spend   METERED     $5.35 spent (2026.09)

DEEPSEEK  (deepseek)                1 window            [METERED]
  metered balance METERED     $20.02 balance
```

### 3. Per-model token usage + full model catalog

Inside each card: a `model × 1h / 5h / 24h` table, plus a **"Show all N models"**
toggle revealing the provider's whole catalog (used models highlighted green).

```
KIMI  (6 models · from provider API)
  model                              1h         5h         24h  reqs(24h)
  kimi-code/kimi-for-coding      23.30M     30.75M      32.41M  213
  kimi-code/k3                        —          —        202k  4
  (+2 catalog models with no traffic: k3-256k, kimi-for-coding-highspeed)
```

Status pills: ⚡ HIGH PRIORITY · 🟧 HIGH · 🟢 ACTIVE · 🟦 LOW · 🔴 COOLDOWN ·
🪙 METERED · ⚠️ UNAVAILABLE. The best window is marked **★ NEXT**.

### 4. Every provider links to its own console

Each card's provider badge is a link that opens the provider's usage/console
page in a new tab, and there's an explicit **open console ↗** link in the card
footer. The provider chips in the status panels are links too. Targets live in
`PROVIDER_URL` in `src/types/quota.ts` — one line each to change:

| Provider | Opens |
|---|---|
| Claude | `claude.ai/settings/usage` |
| ChatGPT | `chatgpt.com` |
| Gemini | `antigravity.google` |
| Kimi | `kimi.ai/settings/subscription?tab=quota` |
| MiniMax | `platform.minimax.io` |
| DeepInfra | `deepinfra.com/dash/usage` |
| DeepSeek | `platform.deepseek.com/usage` |
| Qwen | `modelstudio.console.alibabacloud.com` |

## Quick start (real data)

```bash
cd quota-dashboard
npm install
cp .env.example .env      # optional
npm run dev
```

Real data is the **default**. Open <http://127.0.0.1:5173>. Providers without a
credential show ⚠️ UNAVAILABLE with the exact reason rather than fake numbers.
`npm run dev:mock` gives a drifting fake dataset (no network, no keys).

## Credentials

Environment variables already present in your OS/user environment always win, so
`.env` is only needed for values you don't have set globally.

| Provider | Quota source | Credential | Endpoint |
|---|---|---|---|
| **Claude** | OAuth or claude.ai session | `~/.claude/.credentials.json` or `CLAUDE_SESSION_KEY` | `api.anthropic.com/api/oauth/usage` · `claude.ai/api/organizations/{org}/usage` |
| **ChatGPT** | Codex session | `~/.codex/auth.json` (`codex login`) | `chatgpt.com/backend-api/wham/usage` |
| **Antigravity** | Antigravity / Code Assist | `~/.gemini-profiles/<slug>/.gemini/oauth_creds.json` (`npm run gemini-login`) | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` |
| **Kimi** | Kimi Code Plan + backup wallet | `KIMI_API_KEY` (`sk-kimi-…`) | `api.kimi.com/coding/v1/usages` |
| **MiniMax** | MiniMax coding plan | `MINIMAX_API_KEY` (`sk-cp-…`) | `api.minimax.io/v1/token_plan/remains` |
| **DeepInfra** | API key | `DEEPINFRA_API_KEY` | `api.deepinfra.com/payment/usage` |
| **DeepSeek** | API key | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` |
| **DeepSeek usage** | Platform dashboard | `DEEPSEEK_PLATFORM_TOKEN` (browser session token, not the API key) | `platform.deepseek.com/api/v0/usage/amount` |
| **Qwen** | *no public API* | — (read from `~/.qwen/settings.json`) | — |

### Claude — needs one manual step

**A. Claude Code OAuth (preferred):** run `claude` once and log in; the token
lands in `~/.claude/.credentials.json`.

**B. claude.ai web session:** DevTools → **Application** → **Cookies** →
`https://claude.ai` → copy `sessionKey` → put it in `.env`:

```bash
CLAUDE_SESSION_KEY=sk-ant-sid01-...
```

The org UUID is read automatically from `~/.claude.json`.

> ⚠️ Anthropic's Consumer Terms restrict using Pro/Max OAuth outside Claude Code
> and claude.ai. This reads only your own usage, locally — but treat the session
> cookie like a password and never commit `.env`.

#### Re-subscribing Claude — fix the card fast

When you cancel / re-subscribe, Anthropic invalidates the old session, so the
Claude card can break with one of these:

- `no Claude credential — set CLAUDE_SESSION_KEY … or CLAUDE_CODE_OAUTH_TOKEN`
- `no Claude org UUID — log into Claude Code once, or set CLAUDE_ORG_UUID`
- `Claude usage fetch failed — HTTP 403 …`

**Fix (~2 min):**

1. Grab a fresh session cookie:
   claude.ai → **F12** → **Application** → **Cookies** → `https://claude.ai` →
   copy **`sessionKey`**.
2. Put it in `.env` (the org UUID is stable — don't change it):

   ```bash
   CLAUDE_SESSION_KEY=sk-ant-sid…
   CLAUDE_ORG_UUID=00000000-0000-0000-0000-000000000000
   ```

   The org UUID lives in `~/.claude.json` → `oauthAccount.organizationUuid`.
   If `claude auth logout` wiped it, it's also in
   `~/.claude/backups/.claude.json.backup.*`.
3. Restart: `dashboard` (or `npm run dev`).

**Notes**

- Anthropic rate-limits the OAuth usage endpoint (HTTP 429). The scraper keeps
  the last good reading in `data/claude-usage-cache.json`, shows it with a
  `cached …` label instead of blanking the card, polls at most once every
  5 minutes, and backs off for 10 minutes after a 429. Tune with
  `CLAUDE_MIN_FETCH_INTERVAL_MS`, `CLAUDE_RATE_LIMIT_BACKOFF_MS`, and
  `CLAUDE_CACHE_MAX_AGE_MS`.
- `sessionKey` dies when you sign out of claude.ai — re-grab and update `.env`.
- The Claude **web** fetch already uses `curl` instead of Node `fetch`, because
  claude.ai's Cloudflare bot protection 403s Node's undici TLS fingerprint.
  Don't "simplify" it back to `fetch`.
- The `claude` CLI and Claude Desktop app hold their own OAuth sessions; after
  resubscribing they may also need a re-login (`claude` → `/login`).

### ChatGPT — Codex tokens expire, and rotate

The scraper reuses the access token in `~/.codex/auth.json`. When it expires the
card says *"run `codex login`"*. The dashboard does **not** auto-refresh by
default, because OpenAI **rotates refresh tokens** and refreshing silently can
invalidate the token Codex itself holds. Opt in with `CODEX_ENABLE_REFRESH=1` —
it then writes rotated tokens back to `auth.json` (backing up to
`auth.json.bak-quota-dashboard`).

**Banked resets.** The ChatGPT card also lists each available usage-limit reset
credit and when it expires (soonest first), read from
`chatgpt.com/backend-api/wham/rate-limit-reset-credits`. Only credits with
`status: "available"` are shown; expired or redeemed ones are dropped. If that
endpoint fails, the card still renders and keeps the summary count from
`wham/usage` (*"N banked resets"*).

**Windows are labelled by length, not position.** The API's `primary_window` is
not always the 5-hour session: Plus/Pro return 5h in `primary_window` plus 7d in
`secondary_window`, but plans like `prolite` return **only** the 7d window in
`primary_window` with `secondary_window: null`. The provider therefore derives
the label from `limit_window_seconds` (`>= 6d` → *Weekly* / `chatgpt-weekly`,
`<= 8h` → *5h session* / `chatgpt-5h`, anything else → *"<n>h window"*), and
renders every populated window once. Don't reintroduce position-based naming.

### Kimi — plan windows + backup balance

The Kimi Code usage response also carries `booster_wallet`, the pay-as-you-go
balance Kimi charges after the plan windows are exhausted. Its balance
amounts are in micro-cents (`amountLeft / 1e8`, so `1000000000` = $10.00), so
the card adds a metered **backup balance** row with three figures: remaining
backup balance, the reserved total, and month-to-date spend.

### Antigravity (Gemini) — one card per Google account

Google retired Gemini CLI's individual tier in 2026 (`loadCodeAssist` now
returns `UNSUPPORTED_CLIENT` for personal accounts). The same Code Assist quota
is still served to the **Antigravity** client, so `gemini-login` uses that OAuth
client by default; `--gemini` forces the legacy Gemini CLI client (still useful
for paid Google Cloud projects).

The dashboard reads Gemini CLI's credential format and asks the Code Assist
quota endpoints, so **Gemini CLI does not need to be installed** — you only need
to link each account once.

First add the OAuth client secret to `.env` (see `.env.example`):

```bash
ANTIGRAVITY_OAUTH_CLIENT_SECRET=...   # default client
GEMINI_OAUTH_CLIENT_SECRET=...        # only for --gemini
```

These are installed-app client credentials — not confidential like an API key,
but kept out of the repo because GitHub's secret scanner blocks them.

```bash
npm run gemini-login -- second@example.com
npm run gemini-login -- you@example.com
```

Each run opens a Google sign-in page and writes a profile in Gemini CLI's own
format:

```
~/.gemini-profiles/<slug>/.gemini/oauth_creds.json
profile.json   { "email": …, "client": "antigravity" | "gemini" }
```

Every profile is a valid `GEMINI_CLI_HOME`, so
`GEMINI_CLI_HOME=~/.gemini-profiles/dan.duncalf gemini` uses the same login.
The scraper refreshes expired access tokens in place (backup:
`oauth_creds.json.bak-quota-dashboard`) and renders one card per account.

Quota rows come from the per-model buckets in `retrieveUserQuota` on
`daily-cloudcode-pa.googleapis.com` — the deployment Antigravity's own quota
manager polls — then collapse to one row per shared pool: **Gemini** and
**Claude** (the Claude pool also carries GPT-OSS). Every Gemini model moves
together because they share one weekly limit; Claude-family models share the
other. Rows are ordered most-used first. `retrieveUserQuotaSummary` is only a
fallback for legacy Gemini CLI accounts: its production deployment returns a
placeholder “100% remaining, resets in 7d” response for Starter-tier accounts.

Existing CLI homes can also be picked up without moving files:

```bash
GEMINI_CLI_HOMES=/path/to/home-a,/path/to/home-b
GEMINI_ACCOUNT_PROJECTS=me@example.com=my-gcp-project-123
```

### Qwen — no public quota endpoint

Your Qwen CLI is configured against an **Alibaba ModelStudio Token Plan**
(`~/.qwen/settings.json` → `providerMetadata["token-plan"]`), a single
subscription fronting models from several vendors (qwen3.x, deepseek-v4,
kimi-k2.x, glm-5.x, MiniMax-M2.x). As of writing there is no discoverable usage
API for it, so the quota window shows ⚠️ UNAVAILABLE while its model catalog and
token usage come from local config + logs.

## Token usage: where the numbers come from

Provider quota APIs almost never expose per-model token counts, so usage is read
from the **local CLI logs** these agents already write:

| Source | Location | Fields |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | `token_count` → `info.last_token_usage` (per-turn delta) |
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl` | `usage.record` → `{inputOther, output, inputCacheRead, inputCacheCreation}` |
| Qwen CLI | `~/.qwen/projects/**/chats/*.jsonl` | `usageMetadata.{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,cachedContentTokenCount}` |
| DeepSeek platform | `DEEPSEEK_PLATFORM_TOKEN` (not a log) | daily per-model `PROMPT_CACHE_HIT_TOKEN` / `PROMPT_CACHE_MISS_TOKEN` / `RESPONSE_TOKEN` |

Notes and caveats:

- **Only files touched in the last ~26h are read**, and files >16 MB are tailed,
  so a 1 GB session archive costs nothing on a quiet day (measured: ~0.5 s).
- **Cache reads dominate.** Agentic coding re-sends a large context every turn,
  so "22 M tokens in an hour" typically means ~22 M of *cache reads* plus a few
  hundred k of real input/output. The hover tooltip breaks it down.
- **DeepSeek is day-granular.** Token counts come from platform.deepseek.com's
  daily buckets (authenticated with the browser session token, not the `sk-`
  API key), so its 24h column means *today so far*; 1h/5h are unavailable.
- **Granularity.** Local logs give exact 1h/5h/24h. DeepInfra's billing API is
  the only provider that reports tokens itself, but only **monthly** — shown as a
  separate `monthly (YYYY.MM)` line rather than a fake 24h figure.
- **Attribution is by model name.** A `MiniMax-M2.7` call made through the Qwen
  CLI shows under **MiniMax**, not Qwen — because that's the vendor whose model
  was used. The Qwen card still lists it in its catalog.
- If a provider has no traffic in 24h the card says so and shows when its logs
  were last written (e.g. *"no usage in the last 24h · logs last written
  2026-10-05"*).

## Query it from the terminal (curl)

```bash
curl -s http://127.0.0.1:8787/                            # full grouped report
curl -s 'http://127.0.0.1:8787/?color=1'                  # with ANSI color
curl -s http://127.0.0.1:8787/api/summary                 # alias
curl -s 'http://127.0.0.1:8787/api/quota-state?format=text'
curl -s http://127.0.0.1:8787/api/quota-state | jq '.summary'
curl -s http://127.0.0.1:8787/api/quota-state | jq '.state.provider_models[] | {provider, usage}'
curl -s http://127.0.0.1:8787/ | tail -3                  # "what should I use next?"
```

`Accept: text/plain` (without `application/json`) also returns the text report, so
plain `curl` works with no query param. Browser `fetch` keeps getting JSON.

## Project layout

```
quota-dashboard/
├── data/state.json             ← written by scraper, read by API
└── src/
    ├── env.ts                  ← tiny dependency-free .env loader
    ├── types/quota.ts          ← buckets, provider_models, TokenTally, modelKey()
    ├── scraper/
    │   ├── index.ts            ← orchestrator (real default, --mock for fake)
    │   ├── calculator.ts       ← waste risk + routing priority
    │   ├── mock-generator.ts   ← drifting mock state, same shape as real
    │   ├── providers/          ← claude, chatgpt, gemini, kimi, minimax,
    │   │                         deepinfra, deepseek, qwen
    │   └── usage/
    │       ├── local-usage.ts  ← scans CLI logs → 1h/5h/24h token rollups
    │       ├── catalogs.ts     ← provider model lists (+ DeepInfra monthly)
    │       └── build.ts        ← merges catalogs + rollups per provider
    ├── scripts/
    │   ├── gemini-login.ts    ← link a Google account (Antigravity OAuth)
    │   ├── reset-state.ts
    │   └── calc-check.ts
    ├── server/
    │   ├── index.ts            ← Express + Zod validation
    │   └── text-render.ts      ← grouped report for curl / text clients
    └── ui/
        ├── components/ProviderCard.tsx  ← windows + usage table + catalog toggle
        ├── components/Dashboard.tsx     ← status panels naming providers
        └── lib/{api,meta,cardOrder}.ts
```

## Waste Risk formula

```
Waste Score = (100 - used_pct) / max(1, hours_until_reset)
```

| Condition | Risk | Priority |
|---|---|---|
| `used_pct >= 99` | NONE | 999 |
| unavailable (no credential / no plan) | NONE | 999 |
| `tier_type == 'metered'` | NONE | 99 |
| `hours_until_reset < 24` **and** `used_pct < 40` | CRITICAL | 1 |
| `hours_until_reset < 48` **and** `used_pct < 60` | HIGH | 5 |
| `used_pct >= 80` | LOW | 20 |
| otherwise | MODERATE | 10 |

Sorted by `routing_priority` ascending, `waste_score` descending; ★ NEXT is the
top of that list, skipping exhausted and unavailable windows.

## Card order (drag & drop)

Cards can be dragged into any arrangement; that arrangement becomes the
**custom** order and is remembered in `localStorage`
(`quota-dashboard.card-order.v1`, mode in `quota-dashboard.card-sort.v1`).

The order button cycles **A→Z → ⚡ Best first → ✋ Custom order** (custom only
appears once you've dragged something). A drag always ends in custom mode, and
positions are computed from what's on screen, so you can drag while in either
A→Z or Best-first and the result is still "put it where I dropped it".

- Drag from anywhere on a card; starting on a link/button or on a scroll box
  that genuinely overflows keeps the native click/scroll behaviour.
- Keys are `provider:account`, so the two Antigravity accounts reorder
  independently.
- Providers added after you saved an order appear at the end (alphabetically)
  until you drag them into place.

## Running the scraper as a service

```cron
* * * * * cd /path/to/quota-dashboard && /usr/bin/env node --import tsx src/scraper/index.ts --once >> /tmp/quota-scraper.log 2>&1
```

Or a systemd user unit (`~/.config/systemd/user/quota-scraper.service`):

```ini
[Unit]
Description=Quota Dashboard Scraper Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/quota-dashboard
EnvironmentFile=/path/to/quota-dashboard/.env
ExecStart=/usr/bin/env node --import tsx src/scraper/index.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

## CLI reference

```bash
npm run scrape                # real data (default)
npm run scrape:mock           # drifting mock data
npm run scrape -- --once      # single tick then exit (for cron)
npm run gemini-login -- EMAIL  # link a Gemini Code Assist account
npm run server                # Express API on :8787
npm run ui                    # Vite dev server on :5173
npm run dev                   # all three, REAL data
npm run dev:mock              # all three, mock data
npm run reset-state           # wipe state.json, regenerate mock snapshot
npm run typecheck             # tsc --noEmit
npm run ui:build              # production build of UI → dist-ui/
```

## Extending

- **Add a provider** — add a scraper in `src/scraper/providers/` returning
  `RawBucket[]`, register it in `src/scraper/index.ts`, then add the id to
  `Provider` + `PROVIDER_ORDER` + `PROVIDER_LABEL` in `src/types/quota.ts`, the
  Zod enum in `src/server/index.ts`, and `PROVIDER_META` in `src/ui/lib/meta.ts`.
  Emit `unavailableBucket({...})` on failure instead of fabricating numbers.
- **Add a log source for token usage** — add an entry to `SOURCES` in
  `src/scraper/usage/local-usage.ts` (a `matchName` filter + a `parse` function).
- **Add a window** — push another `RawBucket` with the same `provider`; it renders
  as an extra row in that provider's card.
- **Tune thresholds** — `classifyRisk()` in `src/scraper/calculator.ts`.

## License

MIT — built for personal fleet management. Not affiliated with Anthropic,
OpenAI, Moonshot, MiniMax, DeepInfra, DeepSeek or Alibaba. Provider endpoints
above are internal/undocumented and may change without notice.
