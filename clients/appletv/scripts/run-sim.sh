#!/bin/zsh
# Usage: scripts/run-sim.sh [udid] [out-dir] [settle-seconds]
# Boots an Apple TV simulator (default: the first available), installs the simulator build,
# launches Panda, waits, screenshots, and prints the app's console (mirrored to a file).
set -u
UDID=${1:-$(xcrun simctl list devices available | grep -m1 "Apple TV" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')}
OUT=${2:-./sim-out}; SETTLE=${3:-12}
BUNDLE=app.panda.tv; NAME=Panda
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
APP=$(find platforms/tvos/build -maxdepth 3 -type d -name "$NAME.app" | grep -i simulator | head -1)
[ -z "$APP" ] && { echo "no simulator build; run: . scripts/env.sh && npx ns build tvos --emulator"; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null; open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" || exit 1
xcrun simctl launch "$UDID" "$BUNDLE" > "$OUT/launch.log" 2>&1
sleep "$SETTLE"
xcrun simctl io "$UDID" screenshot "$OUT/screenshot.png" >/dev/null 2>&1 && echo "screenshot: $OUT/screenshot.png"
CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data 2>/dev/null)
[ -n "$CONTAINER" ] && cp "$CONTAINER/Library/Caches/panda-log.txt" "$OUT/console.txt" 2>/dev/null
echo "--- console (last 40 lines) ---"; tail -40 "$OUT/console.txt" 2>/dev/null | cut -c1-300
