#!/bin/sh
# Build, sign, install and launch Panda on your iPhone (or iPad): scripts/run-device.sh [device]
# Without an argument it uses the first connected iPhone/iPad (`xcrun devicectl list devices`).
# A Release build by default (minified, Solid's production build: much faster than the Debug
# build Xcode's Run makes); CONFIG=Debug for the debug one (console logs, -panda* launch options).
#
# NativeScript prepares the Xcode project; xcodebuild builds it for that device, registering
# the device with your team and making the provisioning profile as needed. Your team ID is
# never in the repo: $PANDA_TEAM_ID, else the one line in team.local (git-ignored), else
# ../appletv/team.local.
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
TEAM=${PANDA_TEAM_ID:-$(tr -d ' \n\r' < team.local 2>/dev/null || tr -d ' \n\r' < ../appletv/team.local 2>/dev/null)}
[ -n "$TEAM" ] || { echo "Put your Apple team ID in clients/mobile/team.local (or set PANDA_TEAM_ID)"; exit 1; }

DEVICE=$1
if [ -z "$DEVICE" ]; then
  DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone|iPad/ && !/simulated/ && /connected|available/ {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f-]{25,}$/) {print $i; exit}}')
  [ -n "$DEVICE" ] || { echo "No iPhone or iPad found: connect it by cable (or pair it for Wi-Fi) and trust this Mac"; exit 1; }
fi
UDID=$(xcrun devicectl list devices 2>/dev/null | awk -v d="$DEVICE" 'index($0, d) {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f]{40}$|^[0-9A-F]{8}-[0-9A-F]{16}$/) {print $i; exit}}')
[ -n "$UDID" ] || UDID=$DEVICE

CONFIG=${CONFIG:-Release}
OUT=sim-out/device
echo "Preparing the Xcode project ($CONFIG)..."
if [ "$CONFIG" = Release ]; then
  npx --no-install ns prepare ios --release --teamId "$TEAM" >/dev/null
else
  npx --no-install ns prepare ios --teamId "$TEAM" >/dev/null
fi
echo "Building for $DEVICE..."
xcodebuild -project platforms/ios/Panda.xcodeproj -scheme Panda -configuration "$CONFIG" \
  -destination "id=$UDID" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -derivedDataPath "$OUT" build -quiet
APP="$OUT/Build/Products/$CONFIG-iphoneos/Panda.app"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" app.panda.mobile >/dev/null
echo "Panda is running on $DEVICE."
