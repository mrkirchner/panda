#!/usr/bin/env bash
# The pinned jellyfin-ffmpeg build (packaging/jellyfin-ffmpeg.txt), for the packaging scripts.
#
#   scripts/jellyfin-ffmpeg.sh url <platform>     download URL   (platform: macarm64, linux64, linuxarm64)
#   scripts/jellyfin-ffmpeg.sh sha256 <platform>  its checksum
#   scripts/jellyfin-ffmpeg.sh fetch <platform>   download it once to target/dist/downloads (checked),
#                                                 print the file's path
set -euo pipefail
cd "$(dirname "$0")/.."
pin=packaging/jellyfin-ffmpeg.txt

field() { awk -v k="$1" '$1 == k { print $2 }' "$pin"; }
version=$(field version)
platform="${2:?platform: macarm64, linux64 or linuxarm64}"
sha=$(field "$platform")
[[ -n "$version" && -n "$sha" ]] || { echo "no $platform build pinned in $pin" >&2; exit 1; }
file="jellyfin-ffmpeg_${version}_portable_${platform}-gpl.tar.xz"
url="https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${version}/${file}"

sha_ok() {
  local got
  if command -v shasum >/dev/null; then got=$(shasum -a 256 "$1"); else got=$(sha256sum "$1"); fi
  [[ "${got%% *}" == "$sha" ]]
}

case "${1:-}" in
  url) echo "$url" ;;
  sha256) echo "$sha" ;;
  fetch)
    out="target/dist/downloads/$file"
    mkdir -p "$(dirname "$out")"
    if [[ ! -f "$out" ]] || ! sha_ok "$out"; then
      echo "downloading $file" >&2
      curl -fL --retry 3 --progress-bar -o "$out" "$url"
    fi
    sha_ok "$out" || { echo "jellyfin-ffmpeg checksum mismatch: $out" >&2; exit 1; }
    echo "$out"
    ;;
  *) echo "usage: $0 url|sha256|fetch <platform>" >&2; exit 2 ;;
esac
