# Panda

A self-hosted media server in Rust with a SolidJS + Lightning TV client. Panda streams your
own files (direct play first, HLS transcoding when needed) and requests new media through
Sonarr and Radarr.

## Layout

```
crates/
  panda-media     ffmpeg discovery, capability probe, ffprobe, playback decisions, HLS, subtitles
  panda-library   folder scanning + Sonarr/Radarr-style filename parsing
  panda-arr       typed Sonarr/Radarr v3 clients and webhook payloads
  panda-metadata  TMDB client, title matching, on-disk artwork cache
  panda-db        SQLite (sqlx) with embedded migrations
  panda-server    axum HTTP API (lib + thin `panda` binary)
clients/
  tv              SolidJS on the SolidTV Lightning renderer (WebGL, 10-foot UI)
  web             Admin + account web UI (Solid 2, served by the server at /)
config/
  panda.example.toml
```

Dependencies only point downward: `panda-server` -> `panda-{media,library,metadata,arr,db}`. The
library crates don't know about HTTP.

## Requirements

- Rust (stable, pinned via `rust-toolchain.toml`)
- Node 20+ and pnpm (for the TV client)
- ffmpeg. **jellyfin-ffmpeg is recommended**: it adds HDR tone mapping (`tonemapx`,
  `tonemap_videotoolbox/opencl/cuda/vaapi`) and hardware-acceleration fixes. Stock ffmpeg works,
  but HDR content will look washed out without `zscale`. Panda looks for jellyfin-ffmpeg in
  `/usr/lib/jellyfin-ffmpeg`, `/opt/jellyfin-ffmpeg`, `~/Library/Application Support/jellyfin-ffmpeg`
  (macOS), `~/.local/share/jellyfin-ffmpeg` and `Jellyfin.app`, then falls back to `$PATH`.
  - **macOS:** download `jellyfin-ffmpeg_*_portable_macarm64-gpl.tar.xz` from
    [jellyfin-ffmpeg releases](https://github.com/jellyfin/jellyfin-ffmpeg/releases), verify its
    sha256, and extract `ffmpeg` and `ffprobe` into `~/Library/Application Support/jellyfin-ffmpeg/`.

### Hardware transcoding

| Platform | Pipeline | Status |
|---|---|---|
| macOS (Apple silicon) | VideoToolbox: hw decode, `scale_vt`, `tonemap_videotoolbox` (Metal, Dolby Vision aware), `h264_videotoolbox` | done |
| Any | Software: libx264 + `tonemapx` / `zscale` | done (fallback) |
| Linux Intel/AMD/NVIDIA | VAAPI / QSV / NVENC | planned |

Panda picks hardware automatically and retries in software if a hardware transcode fails.

### Quality, bandwidth and capacity

- **Players choose a quality:** Auto, Original, 1080p (8 Mbps), 720p (4 Mbps) or 480p (2 Mbps),
  remembered per device (Down in the TV player). Auto runs a short speed test against Panda
  (`/api/speedtest`) and budgets 70% of the measured speed; fast home networks get the original.
- **The server fits the stream to the budget:** if a file's bitrate exceeds it, Panda transcodes to
  the tallest ladder step that fits (2160p 20 / 1440p 12 / 1080p 8 / 720p 4 / 480p 2 / 360p 1
  Mbps for H.264). Clients that support HEVC get HEVC at 60% of those rates, so the same
  budget buys more resolution. Lossless audio (TrueHD, DTS, FLAC) becomes AAC when capped.
- **HLS uses fragmented MP4** (required for HEVC) in 3 s segments: ~30% faster first frame
  than 6 s (measured), and finer seeking; copied HEVC is tagged `hvc1`.
- **Throttling:** ffmpeg is paused (SIGSTOP) when it gets `throttle_ahead_secs` (120) ahead of
  the viewer and resumed when they catch up; segments `keep_behind_secs` (120) behind are
  deleted. Abandoned movies stop costing encoder time, and disk use per viewer stays bounded.
- **Transcode slots:** `[transcoding] max_hardware` (default 4) and `max_software` (default one
  per 4 CPU cores). Hardware overflows to software; when both are full a new encode gets a
  clear "server busy" (503). Direct play and remuxes are never limited. The admin dashboard
  shows slot usage and active streams. On an
M4, 4K HDR to 1080p SDR ran 7x real time using ~3 s of CPU per minute of video (software: 3-4.5x
real time, ~140-190 s of CPU).

## Installing on a Mac

**Panda.pkg (Apple silicon, macOS 13+):** download `Panda-<version>.pkg` from a release (or build
it: `scripts/package-mac-pkg.sh`) and double-click it. Panda goes to `/Applications/Panda`, starts
now and at every login, and its page opens (the first time: create your admin account). Install
a newer `.pkg` to update: your settings, accounts and libraries in
`~/Library/Application Support/Panda` are kept. To remove it, double-click **Uninstall Panda** in
`/Applications/Panda` (it asks before deleting your data). The package isn't signed: the first
time, macOS blocks it; open System Settings > Privacy & Security and click **Open Anyway**.

**Standalone (no Homebrew), e.g. for your other Macs:**

```sh
scripts/package-mac-standalone.sh            # -> target/dist/panda-<version>-mac.tar.gz
# copy it to the other Mac, then:
tar xzf panda-0.1.0-mac.tar.gz && cd panda && ./install.sh
```

`install.sh` puts Panda in `~/Applications/Panda`, starts it now and at login, and prints the
admin setup link and the address to use on TVs. Run a newer package's `install.sh` to update
(your data is kept); `~/Applications/Panda/uninstall.sh` removes it (`--delete-data` also
removes accounts and settings). No Apple developer account is needed for your own Macs; if a
copy made with AirDrop or a browser won't open, run `xattr -dr com.apple.quarantine .` in the
folder first.

### Homebrew

```sh
scripts/package-macos.sh --install   # build, then install from a local tap
brew services start panda            # run now and at login
```

Then open http://localhost:8096; the first-run setup link is in
`$(brew --prefix)/var/log/panda.log`. The formula bundles jellyfin-ffmpeg. Settings and the
database live in `~/Library/Application Support/Panda` (put `panda.toml` there), previews and
transcodes in `~/Library/Caches/Panda`. `PANDA_BIND` changes the listen address.

To publish a tap, upload the tarball from `target/dist/` (e.g. to a GitHub release), rerun with
`PANDA_RELEASE_URL=<folder URL>` and `PANDA_HOMEPAGE=<project page>`, and commit
`target/dist/panda.rb` to a `homebrew-panda` repo as `Formula/panda.rb`; then
`brew install <you>/panda/panda`.

## Installing on Linux

Each release has a `.deb` (Debian, Ubuntu), an `.rpm` (Fedora, RHEL 8+) and a tarball, for
amd64 and arm64. They hold a static server and jellyfin-ffmpeg, and run Panda as a systemd
service (`panda.service`, user `panda`):

```sh
sudo apt install ./panda_0.1.0-1_amd64.deb        # or: sudo dnf install ./panda-0.1.0-1.x86_64.rpm
```

The install prints the admin setup link. Settings, the database and artwork live in
`/var/lib/panda` (put `panda.toml` there), caches in `/var/cache/panda`. Installing a newer
package upgrades in place and keeps all of it (the database is backed up to
`/var/lib/panda/backups` before an upgrade changes it). `sudo apt remove panda` removes the
program and keeps your data; `sudo apt purge panda` deletes it too (with the `.rpm`: `dnf remove
panda`, then `sudo rm -rf /var/lib/panda /var/cache/panda`). The `panda` user needs read access
to your library folders. Change the port with `sudo systemctl edit panda`
(`Environment=PANDA_BIND=0.0.0.0:9000`).

Build them yourself with `scripts/package-linux.sh amd64|arm64` (on Linux or macOS: needs
cargo-zigbuild and nfpm; see the script).

### Docker

```sh
docker run -d --name panda --network host --restart unless-stopped \
  -v panda-config:/config -v panda-cache:/cache -v /path/to/media:/media:ro \
  ghcr.io/<owner>/panda
```

`/config` holds your settings and database and survives image upgrades; `/cache` can be thrown
away. Host networking lets TVs find the server on the network; otherwise `-p 8096:8096`. For
hardware encoding add `--device /dev/dri` (Intel/AMD) or `--gpus all` (NVIDIA). The setup link
is in `docker logs panda`.

## Releasing

Set the version in `Cargo.toml`, commit, and push a tag `v<version>`. The Release workflow
(`.github/workflows/release.yml`) builds the admin UI and TV app once, the Linux packages (both
architectures, cross-built with cargo-zigbuild) and the macOS packages, tests an upgrade from
the previous release's `.deb` on Ubuntu (and the `.rpm` on Fedora), then publishes the GitHub
Release (packages, `panda.rb` for the Homebrew tap, `SHA256SUMS`) and pushes the Docker image to
`ghcr.io/<owner>/panda`. Run it by hand to build and test without publishing. Every package
bundles the jellyfin-ffmpeg pinned in `packaging/jellyfin-ffmpeg.txt`; a weekly workflow opens a
pull request when a newer one is out.

## Running in development

Three terminals from the repo root:

```sh
# 1. Server (API on :8096). Reads ./panda.toml, stores data in ./data
cargo run

# 2. Admin web UI with hot reload (http://localhost:5174, proxies /api to :8096)
cd clients/admin && pnpm install && pnpm dev

# 3. TV app (opens http://localhost:<port>/common/, talks to :8096).
#    Renders at 1080p or 720p depending on the screen; force one with ?res=720 / ?res=1080
cd clients/tv && pnpm install && pnpm start
```

First run:

1. The server log prints `Finish setup at http://<this-server>:5174/setup?token=...`. Open it
   (use `localhost`) to create your admin account.
2. The TV app shows a pairing code. Enter it at http://localhost:5174/link.
3. Manage libraries, TMDB/Sonarr/Radarr, users and devices in the admin UI.

Production: `pnpm build` in `clients/admin` and the server serves the UI itself at `/` (or set
`web_dir`). `cargo run --release` for a fast build.

### Metadata (TMDB)

Put a TMDB "API Read Access Token" in `[tmdb] read_access_token` (or `$PANDA_TMDB_TOKEN`).
After each scan, Panda matches new items against TMDB and caches artwork under
`data/images/` as **WebP** (converted once on download with ffmpeg's libwebp; posters ~37%
and backdrops ~56% smaller than TMDB's JPEGs). Existing JPEG caches are converted once in the
background on upgrade. Each image is downloaded once (TMDB image paths never change), and
unmatched titles are retried weekly, so a steady-state rescan makes no TMDB requests.

`GET /api/system` shows which ffmpeg was found, the hardware accelerators that actually
opened, and the available tone-mapping methods.

### First run

On first start (no accounts yet) the server prints a one-time link:

```
WARN No accounts exist yet. Finish setup at http://<this-server>:8096/setup?token=...
```

Only that link can create the first admin, so nobody else on your network can claim the
server first. Everyone else joins through invites (`POST /api/admin/invites`).

### Security model

- **Accounts:** invite-only. Passwords are stored as Argon2id hashes, never plaintext. Login is
  rate-limited per IP and per username, and errors don't reveal which usernames exist.
- **Sessions:** random 256-bit tokens, stored only as SHA-256 hashes. Browsers get an
  `HttpOnly; SameSite=Lax` cookie (`Secure` over HTTPS), and cookie-authenticated writes must
  come from the same origin (CSRF). TVs get a revocable bearer token through device sign-in
  (the TV shows a code, you approve it at `/link`).
- **Secrets at rest:** the TMDB token and Sonarr/Radarr keys are encrypted (XChaCha20-Poly1305)
  with `data/secret.key` (mode 0600), which is never stored in the database. The admin API
  reports whether a secret is set, never its value. **Back up `secret.key` with the database**,
  because without it the stored secrets can't be decrypted.
- **Media URLs:** players can't send auth headers, so streams, HLS segments, subtitles and
  artwork use HMAC-signed `?t=` URLs, bound to one user and one path prefix, with an expiry.
  They stop working as soon as the user is disabled.
- **Headers:** `nosniff`, `Referrer-Policy: no-referrer` (signed URLs never leak via Referer),
  `X-Frame-Options: DENY`.
- **Remote access:** prefer Tailscale. When exposing Panda through a reverse proxy, terminate
  HTTPS there and set `trust_proxy = true`.

### Sonarr / Radarr

Fill in `[radarr]` and `[sonarr]` in `panda.toml`. Then, in each app, go to Settings ->
Connect -> Webhook, choose On Import and On Upgrade, and set the URL to
`http://<panda-host>:8096/webhooks/arr?token=<webhook_token>`.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/setup` | first admin (needs the token from the log) |
| POST | `/api/auth/login`, `/api/auth/logout` | browser session |
| POST | `/api/auth/device/start`, `/poll`, `/approve` | TV device sign-in |
| POST | `/api/auth/invite/accept` | join with an invite code |
| GET | `/api/auth/me` | current user + artwork token |
| * | `/api/admin/*` | settings, users, invites, sessions, libraries, system (admin) |
| GET | `/api/libraries` | libraries the user can see |
| GET | `/api/items?library_id=&kind=&series=&q=&limit=&offset=` | list items |
| GET | `/api/items/{id}` | item + full probe info |
| GET | `/api/series` | one row per series with metadata |
| GET | `/api/images/{key}` | cached artwork (immutable) |
| POST | `/api/items/{id}/playback` | body `{profile, start_secs, audio_index}` -> direct play URL or HLS session |
| GET | `/api/items/{id}/stream` | original file, range requests |
| GET | `/api/items/{id}/subtitles/{index}` | text subtitle track as WebVTT |
| GET / DELETE | `/api/hls/{session}/{file}`, `/api/hls/{session}` | HLS playlist/segments, stop session |
| GET | `/api/search?q=&kind=movie\|series` | Sonarr/Radarr lookup |
| GET / POST | `/api/requests` | list / create requests (auto-approved for now) |
| POST | `/webhooks/arr?token=` | Sonarr/Radarr import notifications |

## Development

```sh
cargo fmt --check && cargo clippy --all-targets && cargo test   # server
cd clients/tv && pnpm lint && pnpm typecheck && pnpm test        # client
```

The server's integration tests (`crates/panda-server/tests/api.rs`) generate small videos with
ffmpeg and exercise scan -> direct play -> HLS -> subtitles end to end. They skip themselves
if ffmpeg isn't on `$PATH`.

## Roadmap

- Admin web UI (`clients/admin`, SolidJS 2.0) with first-run wizard; settings in SQLite
- Remote bitrate caps per user; optional TOTP two-factor
- Multi-server client (pair one TV with several Panda servers), then optional federation
- Fix-match UI for unmatched items; weekly metadata refresh
- Hardware `HwPipeline` impls (VideoToolbox, VAAPI/QSV, NVENC), ported from Jellyfin's `EncodingHelper.cs`
- Seeking past the transcoded range (restart ffmpeg at an offset), transcode throttling
- Bitmap (PGS/VobSub) subtitle overlay
- Users, auth, request approval, watch progress

## License

Panda is licensed under the [Apache License 2.0](LICENSE): use it for anything. If you build
on its code, keep the [NOTICE](NOTICE) file, which credits the original project. Third-party
licenses, credits and trademarks: [LEGAL.md](LEGAL.md).
