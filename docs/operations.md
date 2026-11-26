# Operations

npm scripts, verification, and keeping the dashboard running. For the product
overview and documentation index, see [`../README.md`](../README.md).

## CLI reference

```bash
npm install
npm run scrape                # real data (default)
npm run scrape:mock           # drifting mock data
npm run scrape -- --once      # single tick then exit (for cron)
npm run scrape -- --once --out=PATH  # one-shot scrape to a custom snapshot
npm run gemini-login -- EMAIL  # link a Gemini Code Assist account
npm run server                # Express API on :8787
npm run ui                    # Vite dev server on :5173
npm run ui:build              # production build of UI → dist-ui/
npm run dev                   # all three, REAL data
npm run dev:mock              # all three, mock data
npm run reset-state           # wipe state.json, regenerate mock snapshot
npm run cards:check           # validate card JSON + cross-check state.json
npm run query -- kimi         # agent CLI (same as llmquota.cmd kimi)
npm run mcp                   # MCP server on stdio (for an agent client)
npm run test:agent            # MCP + CLI smoke test
npm run typecheck             # tsc --noEmit
```

The scraper's `--out=PATH` / `SCRAPE_OUT` is the supported way for any
out-of-band caller to write somewhere other than `data/state.json`. See
[`agent.md#data-freshness-and-failure-behavior`](agent.md#data-freshness-and-failure-behavior).

## Verification

Verification for any non-trivial change: `npm run typecheck` must pass.

| Change | Also run |
|---|---|
| UI | `npm run ui:build` |
| Scraper | `npm run scrape:mock` then `curl -s http://127.0.0.1:8787/` |
| Card JSON | `npm run cards:check` |
| `src/agent/` | `npm run test:agent` (needs the dashboard or a fresh `data/state.json`) |
| Any card-related code | `npm run typecheck && npm run cards:check && npm run ui:build` |

## Running the scraper as a service

Ready-made service definitions ship in `scripts/` — install steps are in each
file's header comment:

- **Linux / WSL (systemd):** [`../scripts/llmquota.service`](../scripts/llmquota.service),
  a user unit. On WSL, systemd must be enabled in `/etc/wsl.conf` (see
  [`setup.md#running-under-wsl2-or-plain-linux`](setup.md#running-under-wsl2-or-plain-linux)).
- **macOS (launchd):** [`../scripts/com.llmquota.dashboard.plist`](../scripts/com.llmquota.dashboard.plist),
  a LaunchAgent in `~/Library/LaunchAgents`.
- **Windows:** the logon task [below](#windows-logon-task-this-machine).

The systemd unit and the launchd agent both run
[`../scripts/run-service.sh`](../scripts/run-service.sh), which starts the
scraper daemon and the API server (:8787) — the same pair the Windows
`run-service.cmd` starts via `npm run dev`, minus the Vite dev UI, which is
dev-only. Like the Windows script, it refuses to start a second copy when
:8787 is already served.

Or roll your own — cron with a one-shot scrape:

```cron
* * * * * cd /path/to/quota-dashboard && /usr/bin/env node --import tsx src/scraper/index.ts --once >> /tmp/quota-scraper.log 2>&1
```

Or a minimal systemd user unit (`~/.config/systemd/user/quota-scraper.service`;
the packaged `llmquota.service` adds install comments and runs the API too):

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

### Windows logon task (this machine)

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
