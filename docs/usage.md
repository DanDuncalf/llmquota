# Token usage and model catalogs

Provider quota APIs almost never expose per-model token counts, so usage is read
from the **local CLI logs** these agents already write. For the product overview
and documentation index, see [`../README.md`](../README.md).

| Source | Location | Fields |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | `token_count` → `info.last_token_usage` (per-turn delta) |
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl` | `usage.record` → `{inputOther, output, inputCacheRead, inputCacheCreation}` |
| Qwen CLI | `~/.qwen/projects/**/chats/*.jsonl` | `usageMetadata.{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,cachedContentTokenCount}` |
| DeepSeek platform | `DEEPSEEK_PLATFORM_TOKEN` (not a log) | daily per-model `PROMPT_CACHE_HIT_TOKEN` / `PROMPT_CACHE_MISS_TOKEN` / `RESPONSE_TOKEN` |

## Notes and caveats

- **Only files touched in the last ~26h are read**, and files >16 MB are tailed,
  so a 1 GB session archive costs nothing on a quiet day (measured: ~0.5 s).
- **Cache reads dominate.** Agentic coding re-sends a large context every turn,
  so "22 M tokens in an hour" typically means ~22 M of *cache reads* plus a few
  hundred k of real input/output. The hover tooltip breaks it down.
- **DeepSeek is day-granular.** Token counts come from platform.deepseek.com's
  daily buckets (authenticated with the browser session token, not the `sk-`
  API key), so its 24h column means *today so far*; 1h/5h are unavailable. If
  the token expires, the card keeps showing the balance and the note explains
  why.
- **Granularity.** Local logs give exact 1h/5h/24h. DeepInfra's billing API is
  the only provider that reports tokens itself, but only **monthly** — shown as a
  separate `monthly (YYYY.MM)` line rather than a fake 24h figure.
- **Attribution is by model name.** A `MiniMax-M2.7` call made through the Qwen
  CLI shows under **MiniMax**, not Qwen — because that's the vendor whose model
  was used. The Qwen card still lists it in its catalog.
- If a provider has no traffic in 24h the card says so and shows when its logs
  were last written (e.g. *"no usage in the last 24h · logs last written
  2026-10-05"*).

## Model catalogs

Each card can show the provider's full model list behind a "Show all N models"
toggle, with used models highlighted. The card's `usage.catalog` selects the
source:

| Value | Meaning |
|---|---|
| `api:<provider>` | fetch the live catalog from the provider API (cached by `CATALOG_TTL_MS`, default 15 min) |
| `local:<provider>` | read models from local CLI config, e.g. Qwen's `~/.qwen/settings.json` |
| `observed` | list only models seen in local logs |

`usage.monthly` adds the DeepInfra monthly spend line; `usage.platform` adds the
DeepSeek platform usage source. Log sources are mapped to cards through the
registry (`src/scraper/usage/build.ts`), not hardcoded. To add one, see
[`architecture.md#extending`](architecture.md#extending).
