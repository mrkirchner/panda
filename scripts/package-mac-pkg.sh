#!/usr/bin/env bash
# Build Panda.pkg for Apple silicon Macs: target/dist/Panda-<version>.pkg (unsigned).
# Double-click to install or update: Panda goes to /Applications/Panda, starts now and at every
# login (LaunchAgent local.panda.server) and its page opens. Data stays in the user's
# ~/Library/Application Support/Panda, so updates keep everything. /Applications/Panda has
# "Uninstall Panda" (asks before deleting data).
#
# Unsigned: the first time, macOS asks you to allow it (System Settings > Privacy & Security >
# Open Anyway). PANDA_SKIP_BUILD=1 packages target/release/panda as it is.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "package-mac-pkg.sh builds for Apple silicon Macs; run it on one" >&2
  exit 1
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
dist="target/dist"
work="$dist/pkg-work"
src=packaging/macos/pkg

ffmpeg_tar=$(scripts/jellyfin-ffmpeg.sh fetch macarm64)
[[ -n "${PANDA_SKIP_BUILD:-}" ]] || scripts/build-release.sh

rm -rf "$work" && mkdir -p "$work/root/Applications/Panda/bin" "$work/root/Applications/Panda/ffmpeg" \
  "$work/root/Library/LaunchAgents" "$work/resources"
app="$work/root/Applications/Panda"
cp target/release/panda "$src/panda-agent" "$app/bin/"
tar -xJf "$ffmpeg_tar" -C "$app/ffmpeg" ffmpeg ffprobe
cp "$src/Uninstall Panda.command" config/panda.example.toml LICENSE NOTICE LEGAL.md "$app/"
echo "$version" >"$app/VERSION"
cat >"$app/Open Panda.webloc" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>http://localhost:8096</string></dict></plist>
EOF
chmod 755 "$app/bin/"* "$app/ffmpeg/"* "$app/Uninstall Panda.command"
cp "$src/local.panda.server.plist" "$work/root/Library/LaunchAgents/"
# No ._ files (extended attributes such as quarantine or provenance) in the payload.
xattr -cr "$work/root" 2>/dev/null || true

COPYFILE_DISABLE=1 pkgbuild --root "$work/root" --identifier local.panda.pkg --version "$version" \
  --scripts "$src/scripts" --ownership recommended --install-location / \
  "$work/panda-component.pkg" >/dev/null

for f in welcome.html conclusion.html; do sed "s|@VERSION@|$version|g" "$src/resources/$f" >"$work/resources/$f"; done
cp LICENSE "$work/resources/LICENSE.txt"
sed "s|@VERSION@|$version|g" "$src/distribution.xml" >"$work/distribution.xml"
out="$dist/Panda-$version.pkg"
productbuild --distribution "$work/distribution.xml" --resources "$work/resources" \
  --package-path "$work" "$out" >/dev/null
rm -rf "$work"
echo "built $out ($(du -h "$out" | cut -f1))"
