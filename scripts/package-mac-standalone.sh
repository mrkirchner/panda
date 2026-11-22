#!/usr/bin/env bash
# Build a standalone Panda package for Apple silicon Macs, no Homebrew needed:
#   target/dist/panda-<version>-mac.tar.gz  ->  unpack on any of your Macs, run ./install.sh
# It holds the server (admin UI built in), jellyfin-ffmpeg, and install/uninstall scripts.
# The jellyfin-ffmpeg version and checksum come from packaging/jellyfin-ffmpeg.txt.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "package-mac-standalone.sh builds for Apple silicon Macs; run it on one" >&2
  exit 1
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
dist="target/dist"
stage="$dist/stage/panda"

ffmpeg_tar=$(scripts/jellyfin-ffmpeg.sh fetch macarm64)

scripts/build-release.sh

rm -rf "$dist/stage" && mkdir -p "$stage/bin" "$stage/ffmpeg"
cp target/release/panda "$stage/bin/"
tar -xJf "$ffmpeg_tar" -C "$stage/ffmpeg" ffmpeg ffprobe
cp packaging/macos/install.sh packaging/macos/uninstall.sh packaging/macos/README.txt "$stage/"
cp config/panda.example.toml "$stage/"
# License, credit and legal notes travel with every copy (Apache-2.0 section 4).
cp LICENSE NOTICE LEGAL.md "$stage/"
echo "$version" >"$stage/VERSION"
chmod +x "$stage/install.sh" "$stage/uninstall.sh" "$stage/bin/panda" "$stage/ffmpeg/"*

out="$dist/panda-$version-mac.tar.gz"
tar -C "$dist/stage" -czf "$out" panda
rm -rf "$dist/stage"
echo "built $out ($(du -h "$out" | cut -f1))"
echo "on the other Mac: tar xzf $(basename "$out") && cd panda && ./install.sh"
