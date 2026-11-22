#!/usr/bin/env bash
# Package Panda for Homebrew on Apple silicon Macs.
#
#   scripts/package-macos.sh            build target/dist/panda-<version>-macos-arm64.tar.gz and
#                                       target/dist/panda.rb (a formula pointing at that file)
#   scripts/package-macos.sh --install  also install it from a local tap (local/panda), to try
#                                       it out without publishing anything
#
# To publish: upload the tarball somewhere (e.g. a GitHub release), then run with
# PANDA_RELEASE_URL=<folder URL the tarball is in> and PANDA_HOMEPAGE=<project page>, and commit
# target/dist/panda.rb to your tap repo as Formula/panda.rb.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "package-macos.sh builds for Apple silicon Macs; run it on one" >&2
  exit 1
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
name="panda-${version}-macos-arm64"
dist="target/dist"

scripts/build-release.sh

rm -rf "$dist/$name" && mkdir -p "$dist/$name"
cp target/release/panda "$dist/$name/"
cp config/panda.example.toml "$dist/$name/"
# License, credit and legal notes travel with every copy (Apache-2.0 section 4).
cp LICENSE NOTICE LEGAL.md "$dist/$name/"
# Files at the top of the archive (Homebrew installs from there).
tar -C "$dist/$name" -czf "$dist/$name.tar.gz" panda panda.example.toml LICENSE NOTICE LEGAL.md
rm -rf "${dist:?}/$name"
sha=$(shasum -a 256 "$dist/$name.tar.gz" | cut -d' ' -f1)

base="${PANDA_RELEASE_URL:-file://$PWD/$dist}"
homepage="${PANDA_HOMEPAGE:-http://localhost:8096}"
sed -e "s|@URL@|${base%/}/$name.tar.gz|" \
    -e "s|@VERSION@|$version|" \
    -e "s|@SHA256@|$sha|" \
    -e "s|@HOMEPAGE@|$homepage|" \
    -e "s|@FFMPEG_URL@|$(scripts/jellyfin-ffmpeg.sh url macarm64)|" \
    -e "s|@FFMPEG_SHA256@|$(scripts/jellyfin-ffmpeg.sh sha256 macarm64)|" \
    packaging/homebrew/panda.rb > "$dist/panda.rb"

echo "built $dist/$name.tar.gz ($sha)"
echo "formula: $dist/panda.rb"

if [[ "${1:-}" == "--install" ]]; then
  tap="local/panda"
  if ! brew tap | grep -qx "$tap"; then
    brew tap-new --no-git "$tap" >/dev/null
  fi
  tap_dir="$(brew --repository)/Library/Taps/local/homebrew-panda"
  mkdir -p "$tap_dir/Formula"
  cp "$dist/panda.rb" "$tap_dir/Formula/panda.rb"
  # Same version number, new build: drop the cached download, then reinstall.
  rm -f "$(brew --cache "$tap/panda")"
  if brew list --formula "$tap/panda" >/dev/null 2>&1; then
    brew reinstall "$tap/panda"
  else
    brew install "$tap/panda"
  fi
  echo "installed. Start it with: brew services start panda"
fi
