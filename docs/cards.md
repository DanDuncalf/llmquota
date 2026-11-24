# Cards

Every card on the dashboard is a JSON specification — not a component. One file
per card, loaded at runtime. For the product overview and documentation index,
see [`../README.md`](../README.md).

```
config/cards/*.json   ← shipped with the repo (git)
data/cards/*.json     ← yours (gitignored); same id overrides the shipped card
```

```json
{
  "id": "deepseek",
  "label": "DeepSeek",
  "company": "DeepSeek",
  "url": "https://platform.deepseek.com/usage",
  "palette": "blue",
  "order": 70,
  "aliases": ["deepseek", "deep seek"],
  "windows": [
    { "id": "deepseek-balance", "label": "metered balance",
      "kind": "metered", "tier": "metered", "display": "currency" }
  ],
  "usage": { "catalog": "api:deepseek", "platform": "deepseek" }
}
```

| field | meaning |
|---|---|
| `id` | join key with `state.json` `provider` and the JSON filename; also the UI's drag-order key |
| `label`, `company` | card title and provider name |
| `url` | console/usage page opened by the card's badge and footer link |
| `windows[]` | the rows the card should have. `id` must match the scraper's `model_id`. Empty array = render whatever arrives (per-account cards like Gemini) |
| `windows[].kind` | `five_hour` \| `weekly` \| `daily` \| `monthly` \| `metered` \| `other` — used for headline windows and the "weekly capacity" sort |
| `windows[].tier` | `rolling_window` \| `periodic_fixed` \| `metered` |
| `windows[].hours` | window length; drives ordering and the agent's weekly view |
| `windows[].display` | `percent` \| `currency` \| `note` — picks the row body; no provider branching in the UI |
| `windows[].limit_label` | small grey caption under the row, e.g. "Pro plan" |
| `palette` | one of `orange emerald indigo sky fuchsia blue teal violet rose amber zinc` |
| `shown` | `false` = hidden template: listed in the Cards view, never counted as available capacity and never shown on the dashboard |
| `usage` | `catalog` (`api:*` / `local:*` / `observed`), `logs` (CLI log family), `monthly`, `platform` |
| `order` | ascending sort rank (lower = further left); ties fall back to label |
| `agent` | optional: `harness` + `serves` model list for query matching |

The schema and its defaults live in `src/cards/spec.ts`; the vocabulary (palette
names, window kinds/tiers/displays, id pattern) lives in `src/cards/vocab.ts`.

## Dynamic behavior

The registry re-scans both directories on every request and every scrape tick
(cached on file mtimes). Add, edit or delete a card and it appears/disappears on
the next dashboard poll (≤15 s) and scrape tick (≤60 s) — no restart, no UI
rebuild.

**A JSON-only card works immediately.** With no scraper registered, the card
renders as UNAVAILABLE with the reason — one row per declared window — plus
local token usage if any log source matches. Write a scraper only when you want
real numbers (see [`architecture.md#extending`](architecture.md#extending)).

**A declared window is never silently dropped.** If the scraper reports only
one of two declared windows, the missing one shows as UNAVAILABLE
("not reported by provider"). If the scraper already returns its own
`unavailable` bucket, nothing is synthesized on top of it.

## Starter library

A fresh checkout ships **44 cards**: the 8 live ones (Claude, ChatGPT,
Antigravity, Kimi, MiniMax, DeepInfra, DeepSeek, Qwen) plus **36 hidden
templates** that you can show as your fleet grows:

| group | cards |
|---|---|
| coding plans / agent IDEs | Grok (`xai`), Gemini (`google`), Mistral, Z.ai (GLM), GitHub Copilot, Cursor, Windsurf, Kiro, Perplexity, Trae |
| inference APIs / gateways | Groq, Together AI, OpenRouter, Cerebras, Fireworks, Novita, SiliconFlow, Hyperbolic, Nebius, Lambda |
| cloud platforms | Azure OpenAI, Vertex AI, AWS Bedrock, Doubao (Volcengine), Hunyuan, ERNIE |
| other hosted APIs | Cohere, Hugging Face, Replicate, SambaNova, Chutes, OpenCode Zen, Requesty, Vercel AI Gateway |
| local runtimes | Ollama, LM Studio |

Templates carry identity, palette, console link, sort order and agent aliases,
and declare no windows (`"windows": []`), so a scraper you add later can
report whatever rows the provider actually has.

`shown: false` means **not available**: templates are excluded from the
dashboard grid, the "Available" panel, `summary.providers`,
`summary.total_providers`, the text renderer and the agent's provider list.
Show one in the Cards view (or `PUT /api/cards/<id>` with `"shown": true`)
and it appears on the next scrape tick — as UNAVAILABLE until a scraper reports
measurements for it. Hidden cards still appear in `GET /api/cards` and the Cards
view so they can be shown.

Gemini is represented twice on purpose: `gemini` (label *Antigravity*) tracks
Google Code Assist OAuth accounts, while `google` is the AI Studio / Gemini API
card. Show whichever you actually use.

## Managing cards in the UI

The header's **Cards (N)** button opens the card registry:

- list of every loaded card with source (`shipped` / `user`), window count and
  whether it has data
- **Show / Hide** — flip a card between the dashboard and hidden-template state
- **New card** / **Edit** — form for all spec fields, including windows, with
  server-side validation errors shown inline
- **Delete** — removes that card's JSON file
- load errors (unparseable files, filename/id mismatch) and orphan providers
  (buckets with no card) are listed so nothing is invisible

Each dashboard card also has a **☰ menu** (top right) with **Refresh**
(re-scrape that card immediately), **Hide**, **Edit** (opens the Cards view
with the editor) and **Delete**.

The HTTP endpoints behind this are listed in [`api.md`](api.md#card-api).

## Validate before committing

```bash
npm run cards:check     # zod + duplicate window ids + state.json cross-check
```

Card JSON is validated with zod at load time, not by `tsc`. One bad file must
never take the dashboard down: the loader reports `{file, message}` in
`GET /api/cards` and `/api/health`, and keeps the previous good version of that
card. A filename/id mismatch is also reported. Run `npm run cards:check` before
committing.
