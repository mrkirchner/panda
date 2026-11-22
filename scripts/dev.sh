#!/usr/bin/env bash
# Development in one terminal: the Panda server (:8096) and the live-reloading admin UI (:5174).
# Ctrl-C stops both. (The TV app runs on its own: `pnpm start` in clients/tv.)
# The server alone also serves the admin UI (built into it), but that's the last `pnpm build`:
# use :5174 while working on the UI.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT INT TERM
scripts/restart-dev-server.sh
tail -n 0 -F target/panda-dev.log &
(cd clients/web && pnpm dev 2>&1 | sed 's/^/[web] /') &
echo "server  http://localhost:8096   admin (live)  http://localhost:5174"
wait
