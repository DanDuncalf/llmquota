# Quota Dashboard — Multi-LLM Fleet

A local-first web dashboard + polling daemon that tracks your **real** LLM
subscription quotas across **Claude, ChatGPT (Codex), Gemini/Antigravity, Kimi,
MiniMax, DeepInfra, DeepSeek and Qwen**. It normalizes their rolling / weekly /
metered windows into a single shape, reports per-model token usage from local
CLI logs, lists every model each provider offers, and computes a **Waste Risk
Score** so you burn expiring free capacity before falling back to
pay-as-you-go.

```
scraper daemon (60s) ──► data/state.json ──► Express API :8787 ──► React UI :5173
   ├─ provider quota APIs                                        └─► llmquota CLI / MCP
   ├─ provider model catalogs
   └─ local CLI logs (token usage)
```

Cards are data, not code: each subscription is a JSON spec in `config/cards/`
(shipped) or `data/cards/` (yours), loaded at runtime. Add a provider by editing
JSON; write a scraper only when you want real measurements.

## Quick start

```bash
npm install
cp .env.example .env      # optional
npm run dev               # scraper (real) + API + UI
```

Open <http://127.0.0.1:5173>. Real data is the **default**; providers without a
credential show ⚠️ UNAVAILABLE with the exact reason instead of fake numbers.
`npm run dev:mock` gives a drifting fake dataset (no network, no keys).

## Documentation

| Document | Contents |
|---|---|
| [`docs/setup.md`](docs/setup.md) | Credentials for every provider, provider-specific quirks, `.env` tuning |
| [`docs/dashboard.md`](docs/dashboard.md) | What the UI shows: status panels, card windows, usage tables, console links, Waste Risk Score, drag-and-drop order |
| [`docs/cards.md`](docs/cards.md) | Card JSON specification, starter library, `shown` / hidden templates, editing cards in the UI |
| [`docs/usage.md`](docs/usage.md) | Where per-model token usage and model catalogs come from, and their caveats |
| [`docs/api.md`](docs/api.md) | HTTP API and `curl` text report |
| [`docs/agent.md`](docs/agent.md) | `llmquota` CLI and the stdio MCP server |
| [`docs/operations.md`](docs/operations.md) | npm script reference, running as a service (cron, systemd, Windows logon task), verification |
| [`docs/architecture.md`](docs/architecture.md) | Data flow, module layout, state contract, extending scrapers and log sources |
| [`AGENTS.md`](AGENTS.md) | Conventions and invariants for coding agents working on this repo |

## License

MIT — built for personal fleet management. Not affiliated with Anthropic,
OpenAI, Moonshot, MiniMax, DeepInfra, DeepSeek or Alibaba. Provider endpoints
are internal/undocumented and may change without notice.
