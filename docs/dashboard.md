# Dashboard UI

What the dashboard shows and how to read it. For the product overview and
documentation index, see [`../README.md`](../README.md).

## 1. Status panels that name providers

Each status lists **which providers** are behind it — not just a count:

```
PROVIDERS    Claude, ChatGPT, Antigravity, Kimi, MiniMax, DeepInfra, DeepSeek, Qwen
CRITICAL     ChatGPT
HIGH         Kimi
COOLDOWN     —
METERED      DeepInfra, DeepSeek
UNAVAILABLE  Claude, MiniMax, Qwen
```

## 2. One card per subscription, one row per quota window

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
  balance & spend METERED     $4.93 available
                              spent 2026.11 · $1.75 · month to date

DEEPSEEK  (deepseek)                1 window            [METERED]
  metered balance METERED     $20.02 balance
                              Pay-as-you-go · prepaid
```

## 3. Per-model token usage + full model catalog

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

Where the numbers come from: [`usage.md`](usage.md).

## 4. Every provider links to its own console

Each card's provider badge is a link that opens the provider's usage/console
page in a new tab, and there's an explicit **open console ↗** link in the card
footer. The provider chips in the status panels are links too. The target is
the card's `url` field in `config/cards/<id>.json` — one line each to change:

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

## Waste Risk Score

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
top of that list, skipping exhausted and unavailable windows. The rules live in
`classifyRisk()` in `src/scraper/calculator.ts`.

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
