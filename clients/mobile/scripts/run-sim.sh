#!/bin/zsh
# Usage: scripts/run-sim.sh [udid] [out-dir] [settle-seconds] [-pandaOpen <screen>]
# Boots an iPhone simulator (default: the first iPhone 17 Pro, else any iPhone), installs the
# simulator build, launches Panda, waits, screenshots, and saves the app's console output.
# Build first: . scripts/env.sh && npx ns build ios --emulator
set -u
UDID=${1:-$(xcrun simctl list devices available | grep -m1 "iPhone 17 Pro (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')}
[ -z "$UDID" ] && UDID=$(xcrun simctl list devices available | grep -m1 "iPhone" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
OUT=${2:-./sim-out}; SETTLE=${3:-8}; shift $(( $# < 3 ? $# : 3 ))
BUNDLE=app.panda.mobile; NAME=Panda
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
# The newest simulator build (Debug or Release; only Debug takes the -panda* launch options).
APP=$(ls -dt platforms/ios/build/*-iphonesimulator/"$NAME.app" 2>/dev/null | head -1)
[ -z "$APP" ] && { echo "no simulator build; run: . scripts/env.sh && npx ns build ios --emulator"; exit 1; }
# An interrupted Xcode step can leave the app unsigned (iOS then refuses to start it) or stale.
codesign -v "$APP" 2>/dev/null || { echo "$APP isn't signed: build again"; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null; open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" || exit 1
xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE" "$@" > "$OUT/console.txt" 2>&1 &
sleep "$SETTLE"
xcrun simctl io "$UDID" screenshot "$OUT/screenshot.png" >/dev/null 2>&1 && echo "screenshot: $OUT/screenshot.png"
echo "--- console (last 30 lines) ---"; tail -30 "$OUT/console.txt" | cut -c1-300
