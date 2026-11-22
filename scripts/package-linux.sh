#!/usr/bin/env bash
# Package Panda for Linux: a static server (musl) plus the pinned jellyfin-ffmpeg build.
#
#   scripts/package-linux.sh amd64|arm64
#
# Output in target/dist:
#   panda_<version>-1_<arch>.deb        Debian, Ubuntu, ...   (sudo apt install ./panda_...deb)
#   panda-<version>-1.<arch>.rpm        Fedora, RHEL, ...     (sudo dnf install ./panda-...rpm)
#   panda-<version>-linux-<arch>.tar.gz anything else: the program, ffmpeg and the systemd unit
#
# Needs: rustup target <arch>-unknown-linux-musl, cargo-zigbuild + zig (any host, also macOS)
# or a musl C compiler, pnpm, and nfpm (https://nfpm.goreleaser.com) for the .deb/.rpm.
# PANDA_SKIP_UI=1 reuses the UIs already built; PANDA_SKIP_BUILD=1 packages the binary already
# built for that target.
set -euo pipefail
cd "$(dirname "$0")/.."

arch="${1:?usage: scripts/package-linux.sh amd64|arm64}"
case "$arch" in
  amd64) target=x86_64-unknown-linux-musl; ffmpeg=linux64 ;;
  arm64) target=aarch64-unknown-linux-musl; ffmpeg=linuxarm64 ;;
  *) echo "unknown arch $arch (amd64 or arm64)" >&2; exit 2 ;;
esac

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
dist="target/dist"
stage="$dist/stage-linux"  # (the path nfpm.yaml names)

ffmpeg_tar=$(scripts/jellyfin-ffmpeg.sh fetch "$ffmpeg")
[[ -n "${PANDA_SKIP_BUILD:-}" ]] || scripts/build-release.sh --target "$target"

rm -rf "$stage" && mkdir -p "$stage/panda/ffmpeg"
cp "target/$target/release/panda" "$stage/panda/panda"
tar -xJf "$ffmpeg_tar" -C "$stage/panda/ffmpeg" ffmpeg ffprobe
chmod 755 "$stage/panda/panda" "$stage/panda/ffmpeg/"*

# The .deb and .rpm.
if command -v nfpm >/dev/null; then
  export PANDA_ARCH="$arch" PANDA_VERSION="$version"
  export PANDA_HOMEPAGE="${PANDA_HOMEPAGE:-https://github.com/${GITHUB_REPOSITORY:-panda/panda}}"
  nfpm package --config packaging/linux/nfpm.yaml --packager deb --target "$dist/"
  nfpm package --config packaging/linux/nfpm.yaml --packager rpm --target "$dist/"
else
  echo "nfpm not found: skipping the .deb and .rpm (https://nfpm.goreleaser.com/install/)" >&2
fi

# The tarball: same files, laid out to unpack anywhere (README.txt says how to run it).
cp packaging/linux/panda.service packaging/linux/README.txt config/panda.example.toml \
  LICENSE NOTICE LEGAL.md "$stage/panda/"
echo "$version" >"$stage/panda/VERSION"
tar -C "$stage" -czf "$dist/panda-$version-linux-$arch.tar.gz" panda
rm -rf "$stage"
rpm_arch=$([[ $arch == amd64 ]] && echo x86_64 || echo aarch64)
for f in "panda_${version}-1_$arch.deb" "panda-${version}-1.$rpm_arch.rpm" "panda-$version-linux-$arch.tar.gz"; do
  [[ -f "$dist/$f" ]] && echo "built $dist/$f"
done
