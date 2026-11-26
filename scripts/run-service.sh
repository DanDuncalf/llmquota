#!/usr/bin/env bash
# =============================================================================
# run-service.sh — start the llmquota service: scraper daemon + API server.
#
# Linux/macOS/WSL counterpart of run-service.cmd. The Vite dev UI is dev-only
# and intentionally NOT started here; the service is the two long-lived
# processes the data flows through:
#
#   scraper daemon (tsx src/scraper/index.ts)  → writes data/state.json
#   API server     (tsx src/server/index.ts)   → serves :8787 from state.json
#
# One wrapper for both service managers so the units stay tiny:
#   systemd user unit:   scripts/llmquota.service
#   macOS launchd agent: scripts/com.llmquota.dashboard.plist
#
# Behavior (mirrors run-service.cmd):
#   - cd to the repo root (parent of scripts/)
#   - refuse to start a second copy if :8787 is already served
#   - run both processes in the foreground; if either dies, kill the other and
#     exit non-zero so the service manager (Restart=on-failure / KeepAlive)
#     restarts the pair
#   - stdout/stderr go to the service manager's log (journald, or the plist's
#     StandardOutPath); run it by hand to debug
#
# node must be on PATH. Service managers start with a minimal PATH — the unit
# and the plist both carry an Environment/EnvironmentVariables line for nvm /
# homebrew installs. .env is loaded by the app itself (src/env.ts).
# =============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data

if ! command -v node >/dev/null 2>&1; then
  echo "run-service: node not found on PATH (PATH=$PATH)" >&2
  exit 1
fi

TSX=node_modules/tsx/dist/cli.mjs

# Don't start a second copy if the API port is already served.
if node -e 'const s=require("net").connect(8787,"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))'; then
  echo "run-service: 127.0.0.1:8787 is already served — leaving it alone"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting llmquota service (scraper daemon + API :8787)"

node "$TSX" src/scraper/index.ts &
scraper_pid=$!
node "$TSX" src/server/index.ts &
server_pid=$!

kill_children() {
  kill "$scraper_pid" "$server_pid" 2>/dev/null
}
# systemctl stop / launchctl bootout sends TERM: kill the pair and exit 0 so
# the service records a clean stop instead of falling through to `exit 1`
# (which marks the unit "failed" after an intentional stop).
on_stop() {
  kill_children
  exit 0
}
trap on_stop INT TERM
trap kill_children EXIT

# bash 3.2 (macOS) has no `wait -n`, so poll. When either process dies, the
# EXIT trap stops the other and we exit 1 so the service manager brings the
# pair back.
while kill -0 "$scraper_pid" 2>/dev/null && kill -0 "$server_pid" 2>/dev/null; do
  sleep 5
done
exit 1
