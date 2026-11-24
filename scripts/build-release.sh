#!/usr/bin/env bash
# Build the single Panda server program: the admin UI (clients/admin), the TV app for browsers
# (clients/tv) and the web app for watching (clients/web) are built first and then
# bundled into the binary (crates/panda-server/build.rs). Output: target/release/panda.
#
#   scripts/build-release.sh                                   for this machine
#   scripts/build-release.sh --target x86_64-unknown-linux-musl  another target (static Linux:
#                       *-linux-musl), built with cargo-zigbuild when it's installed; output
#                       target/<target>/release/panda
# PANDA_SKIP_UI=1 reuses the UIs already built (several targets in a row).
set -euo pipefail
cd "$(dirname "$0")/.."

target=""
if [[ "${1:-}" == "--target" ]]; then target="${2:?--target needs a target triple}"; fi

if [[ -z "${PANDA_SKIP_UI:-}" ]]; then
  (cd clients/admin && pnpm install --frozen-lockfile && pnpm build)
  # The TV app for browsers, served at /tv.
  (cd clients/tv && pnpm install --frozen-lockfile && pnpm build:server)
  # The web app for watching, served at /watch (shares the TV app's sources: after it).
  (cd clients/web && pnpm install --frozen-lockfile && pnpm build)
fi

if [[ -z "$target" ]]; then
  cargo build --release -p panda-server --bin panda
  echo "built target/release/panda (admin UI included)"
else
  build=build
  if command -v cargo-zigbuild >/dev/null; then build=zigbuild; fi
  cargo "$build" --release --target "$target" -p panda-server --bin panda
  echo "built target/$target/release/panda (admin UI included)"
fi
