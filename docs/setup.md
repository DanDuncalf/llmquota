# Setup and credentials

Configure and connect each provider. For install and first run, see
[`../README.md#quick-start`](../README.md#quick-start). For the product overview
and documentation index, see [`../README.md`](../README.md).

Environment variables already present in your OS/user environment always win, so
`.env` is only needed for values you don't have set globally. See
[`.env.example`](../.env.example) for every knob.

## Tracked cards and their credentials

| Card id | Label | Quota source | Credential | Endpoint |
|---|---|---|---|---|
| `anthropic` | Claude | OAuth or claude.ai session | `~/.claude/.credentials.json` or `CLAUDE_SESSION_KEY` | `api.anthropic.com/api/oauth/usage` · `claude.ai/api/organizations/{org}/usage` |
| `openai` | ChatGPT | Codex session | `~/.codex/auth.json` (`codex login`) | `chatgpt.com/backend-api/wham/usage` |
| `gemini` | Antigravity | Antigravity / Code Assist OAuth, one card per account | `~/.gemini-profiles/<slug>/.gemini/oauth_creds.json` (`npm run gemini-login`) | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` |
| `moonshot` | Kimi | Kimi Code Plan + backup wallet | `KIMI_API_KEY` (`sk-kimi-…`) or the Kimi Code OAuth credential file (self-refreshed) | `api.kimi.com/coding/v1/usages` |
| `minimax` | MiniMax | MiniMax coding plan | `MINIMAX_API_KEY` (`sk-cp-…`) | `api.minimax.io/v1/token_plan/remains` |
| `deepinfra` | DeepInfra | API key (metered spend) | `DEEPINFRA_API_KEY` | `api.deepinfra.com/payment/usage` |
| `deepseek` | DeepSeek | API key (metered balance) | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` |
| `deepseek` (usage) | DeepSeek | Platform dashboard | `DEEPSEEK_PLATFORM_TOKEN` (browser session token, not the API key) | `platform.deepseek.com/api/v0/usage/amount` |
| `qwen` | Qwen | *no public API* | — (read from `~/.qwen/settings.json`) | — |

### Claude — needs one manual step

**A. Claude Code OAuth (preferred):** run `claude` once and log in; the token
lands in `~/.claude/.credentials.json`.
The dashboard refreshes this token itself (using the refresh token in that file)
and writes the rotated pair back, so the `claude` CLI stays logged in. You only
need to log in again if the refresh token is revoked; the card then says
"Claude login expired".

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

**The credential outlives the session.** `KIMI_API_KEY` only exists inside a
live Kimi Code session, so the scraper falls back to the CLI's OAuth file
(`kimi.ts` tries `$KIMI_CODE_HOME`, `~/.kimi-code`, `~/.kimi` — some slots are
emptied migration leftovers, so content is checked, not just existence). The
stored access token is itself a valid Bearer for the usages endpoint; when
expired the scraper refreshes it via `auth.kimi.com/api/oauth/token` and writes
the rotated pair back atomically, lock-file guarded, the same way the Claude
scraper does.

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
`GEMINI_CLI_HOME=~/.gemini-profiles/<slug> gemini` uses the same login.
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

## Secrets

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
- Before committing, scan for tokens/keys/PII:
  `grep -rniE "sk-ant|sk-kimi|sk-cp|gho_|ghp_|github_pat|sessionKey=" . --exclude-dir=node_modules`

## Operational tuning

| Variable | Purpose |
|---|---|
| `SCRAPE_INTERVAL` | Scrape cadence in seconds (minimum 10, default 60) |
| `SCRAPE_OUT` | Where an out-of-band one-shot scrape writes (the daemon always writes `data/state.json`) |
| `SCRAPE_HTTP_TIMEOUT_MS`, `SCRAPE_HTTP_RETRIES` | Per-request timeout and retry count for provider scrapers |
| `CATALOG_TTL_MS` | Model catalog cache (default 15 min) |
| `USAGE_LOOKBACK_HOURS`, `USAGE_MAX_FILE_BYTES`, `USAGE_MAX_FILES` | Local token-usage scan tuning |
| `CLAUDE_MIN_FETCH_INTERVAL_MS`, `CLAUDE_RATE_LIMIT_BACKOFF_MS`, `CLAUDE_CACHE_MAX_AGE_MS` | Claude 429 handling (defaults 5 min, 10 min, 6 h) |
| `CODEX_ENABLE_REFRESH` | `1` lets the scraper rotate Codex tokens |
| `API_PORT`, `API_HOST` | API bind address (default `127.0.0.1:8787`) |

The agent layer's variables are listed in [`agent.md`](agent.md#environment).
