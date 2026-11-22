#!/bin/sh
# Build, sign, install and launch on a paired Apple TV: scripts/run-device.sh [device id or name]
# Without an argument it uses the first paired Apple TV (`xcrun devicectl list devices`).
#
# NativeScript prepares the Xcode project; xcodebuild then builds it for that exact device with
# -allowProvisioningDeviceRegistration, which registers a new Apple TV with the team and creates
# the provisioning profile (`ns run` can do neither, and NativeScript 9.2 also writes an empty
# DEVELOPMENT_TEAM unless given --teamId). The team ID is yours, never in the repo:
# $PANDA_TEAM_ID, else the one line in team.local (git-ignored).
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
TEAM=${PANDA_TEAM_ID:-$(tr -d ' \n\r' < team.local 2>/dev/null)}
[ -n "$TEAM" ] || { echo "Put your Apple team ID in clients/appletv/team.local (or set PANDA_TEAM_ID)"; exit 1; }

DEVICE=$1
if [ -z "$DEVICE" ]; then
  DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '/AppleTV/ && !/simulated/ && /connected|available/ {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f-]{25,}$/) {print $i; exit}}')
  [ -n "$DEVICE" ] || { echo "No paired Apple TV found (see docs/DEVICES.md to pair one)"; exit 1; }
fi
UDID=$(xcrun devicectl list devices 2>/dev/null | awk -v d="$DEVICE" 'index($0, d) {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f]{40}$|^[0-9A-F]{8}-[0-9A-F]{16}$/) {print $i; exit}}')
[ -n "$UDID" ] || UDID=$DEVICE

CONFIG=${CONFIG:-Debug}
OUT=sim-out/device
echo "Preparing the Xcode project..."
npx --no-install ns prepare tvos --teamId "$TEAM" >/dev/null
echo "Building for $DEVICE ($CONFIG)..."
xcodebuild -project platforms/tvos/Panda.xcodeproj -scheme Panda -configuration "$CONFIG" \
  -destination "id=$UDID" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -derivedDataPath "$OUT" build -quiet
APP="$OUT/Build/Products/$CONFIG-appletvos/Panda.app"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" app.panda.tv >/dev/null
echo "Panda is running on $DEVICE."
