#!/usr/bin/env bash
# Rebuild and restart the local dev server (target/debug/panda on :8096), detached, logging to
# target/panda-dev.log. Only touches the debug build: e2e runs from target/release are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -p panda-server --bin panda
pkill -f 'target/debug/panda$' || true
# Wait for the old one to let go of the port.
for _ in $(seq 1 50); do lsof -iTCP:8096 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.1; done
nohup target/debug/panda > target/panda-dev.log 2>&1 &
for _ in $(seq 1 100); do
  if curl -fs http://localhost:8096/health >/dev/null 2>&1; then
    echo "panda restarted"
    exit 0
  fi
  sleep 0.1
done
echo "panda did not come up; see target/panda-dev.log" >&2
exit 1
