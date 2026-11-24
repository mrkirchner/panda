# Panda: working notes

## Hard rules
- **Never burn subtitles into video.** Transcodes always pass `-sn`. Text tracks are served as
  WebVTT; PGS tracks are copied out to `.sup` in the background (`services/bitmap_subs.rs`),
  decoded by `panda_media::pgs` into timed PNG cues, and drawn by the client as an overlay.
  DVD VobSub isn't supported yet (its track `url` is null).
  Subtitle files next to a video (`Movie.en.srt`, `.en.hi.srt`, `.es.forced.srt`, as Bazarr
  writes them; srt/ass/ssa/vtt) are found when playback starts (`panda_media::sidecar`, listed
  off the runtime under a 3 s timeout), sent as `external` tracks with a URL by id
  (`/subtitles/files/{id}`, never a name or path), converted to WebVTT and cached by size +
  mtime (a replaced file converts again). A movie's versions share their files (a 4K copy's `.en.srt` is offered on the
  1080p one as `from_version`, only from libraries the profile can see: Bazarr manages one Radarr). Non-UTF-8 files are read as Windows-1252. The TV's
  Built-in text tracks: a whole-track pass reads the whole file (minutes over a share), so the
  player asks `?from=<secs>` for 10-minute windows (a seek, under a second) while the whole track
  extracts in the background and is cached (`NOTE panda complete` marks it; a sparse track's
  window not ready in 10 s answers `NOTE panda pending` and the player asks again). Subtitles menu has per-track timing (`playback/subtitles.ts`, remembered per file + track
  key in localStorage), applied to the cue lookup for text and image subtitles alike.
- **Never link FFmpeg.** Always run `ffmpeg`/`ffprobe` as subprocesses (GPL separation, and
  users can swap in jellyfin-ffmpeg).
- **Never store or log a plaintext password or secret.** Passwords: Argon2id via `panda-auth`.
  Tokens: store `token::digest()` only. Secrets Panda must reuse: `SecretBox` (encrypted at
  rest, setting key as context). The admin API never returns a secret, only "is it set".
- Every new route goes in the right group in `routes/mod.rs` (public / user / media / admin).
  Media URLs handed to players must be signed (`auth::sign_media`, `with_token`).
- Add a test to `crates/panda-server/tests/security.rs` for every new auth-relevant behavior.
- Accounts: an account is a person who signs in plus up to 8 profiles (`MAX_PROFILES`), keyed
  by its owner: every profile's `users.account_id` is the owner's id (the owner's is its own).
  TVs (`devices.account_id`) list only their account's profiles and never mix accounts; an
  invite always creates a new account. Profiles made on a TV are `managed` (no password)
  until given their own sign-in: a one-time link (`sign_in_links`, email carried by the link,
  emailed when mail is set up) where the person picks their password; then they sign in with
  email or username, and a TV they sign in on joins the account. Turning it off ends their
  other sessions. Editing/deleting a profile on a TV signs in as it first (PIN
  enforced); the owner (primary) can't be deleted from a TV, and deleting an owner deletes the
  account (FK cascade). Library access is set on the owner and applies to the whole account.
- Preview clips (`panda_media::clip`, `services/clips.rs`, `routes/clips.rs`): ~30 s from a
  seek a few minutes in (never a full pass), 720p H.264 + AAC faststart MP4, `-sn`, HDR
  tone-mapped, from the title's smallest version (a show's first episode). Cached in
  `cache/clips` (trimmed like previews). TV: `playback/preview.ts` plays one at a time under the
  canvas (hero: full screen; expanded card: through a hole punched in App's always-mounted
  background), quiet (0.2) or silent per profile (`users.preview_sound`); off on low tier.
- Scrub previews (`panda_media::trickplay`, `services/trickplay.rs`): one frame per request,
  seeked (`-ss` before `-i`) keyframe only, never a full-file pass (libraries live on network
  shares). Cached per item + 10 s step; HDR uses the transcodes' software tone-map filter; JPEG
  needs full-range YUV.
- Libraries live on network shares that can drop: never prune unless every folder answered
  and had files (an empty mount folder counts as offline), never block on a filesystem call
  without a timeout, and fail playback fast with `ApiError::Offline` (503) when the file
  doesn't answer.
  `services/library_health.rs` checks each library every minute (`/api/libraries/offline`; the
  TV's TopBar and the admin dashboard say so) and rescans one when it's back.
  `services/library_watch.rs` watches library folders (`[scanning] watch`, default on) and
  rescans a folder 15 s after changes go quiet; interval scans stay as the backstop.
- Library lists in request paths come from `crate::catalog` (movies grouped into titles, shows),
  built once and rebuilt when `catalog_version` moves (DB triggers on items/metadata/episodes/
  libraries). Don't query or group the whole library per request; add new shown columns to the
  triggers in migration 0018's style.
- Database upgrades: `Db::open` copies the database to `backups/` (`VACUUM INTO`, newest 3)
  before applying migrations, and refuses a database from a newer Panda (`NewerDatabase`).
- Prefer direct play, then remux (`-c copy`), and only then encode.
- Bandwidth: `ClientProfile.max_bitrate_kbps` drives `decide()` via the ladder in
  `transcode.rs` (`height_for_budget`, `video_bitrate_kbps`). Keep budget math in the planner,
  never in pipelines. HLS output is fMP4; playlist signing must cover `#EXT-X-MAP` URIs.
- Every HLS session holds a `services::sessions::Ticket` for its slot (RAII release). Never
  start ffmpeg without one; remux tickets are unlimited, encode tickets are capped.
- Encodes go through `transcode::select_pipeline` (hardware first, software fallback). Every
  encode carries its colours in the stream (`colour_tags`: `h264_metadata`/`hevc_metadata` after
  the encoder; VideoToolbox writes none, and Android then draws no picture). Never as
  `-color_primaries`/`-colorspace` output options: ffmpeg tries to convert hardware frames and
  the encoder never opens. New
  hardware backends implement `HwPipeline`; size frames with `fit_within` (never stretch), and
  add an args snapshot test plus a `pipeline_selection` case. Any change to
  `panda_media::playback::decide` must keep that order.
- Settings drive what's offered: the server decides per item (`can_request` needs that kind's
  Radarr/Sonarr; suggestions need TMDB + the server; emails need mail, else links are returned
  to share) and refuses before saving anything. `/api/features` tells apps what's set up;
  clients follow the server's flags rather than their own rules. Outgoing mail: SMTP settings
  (`Service::Mail`, encrypted), `services/mail.rs`; invites and sign-in links can be emailed.
- Outside services (Radarr/Sonarr HD and 4K, Bazarr, mail): `services/external.rs`, a `Service`
  with its `Spec` (setting id = route name = encryption context, never renamed; the
  `/api/features` flags it turns on; whether `Integrations` are rebuilt) and a `ServiceConfig`
  (admin input where a left-out secret keeps the stored one, `check` against the service before
  anything is saved, a view with secrets only as "is it set"). One `PUT/DELETE
  /api/admin/settings/{id}` serves them all. A new one: variant + `Spec` + config type, its arm
  in `routes/admin.rs` `put_service`, its `SettingsView` field and admin card; add it to the
  services loop in `security.rs`. Metadata providers have their own `Spec` (below).
- Bazarr (optional, `Service::Bazarr`, encrypted; admin `PUT/DELETE /api/admin/settings/bazarr`,
  checked against Bazarr before saving; `/api/features` `subtitle_search`): `POST
  /api/items/{id}/subtitles/find {language}` asks it to search and download subtitles for that
  file, found in Bazarr by file name (it mounts the share elsewhere: `panda_arr::bazarr::tail`),
  for a movie also through another version Bazarr knows (one Radarr per Bazarr). Tests run a fake
  Bazarr (`common::fake_bazarr`).
- Radarr/Sonarr cleanup (`services/arr_cleanup.rs`, off by default, switches per kind, weekly
  plus "Run now"): only titles Panda requested and has in its library, a week after download,
  quality cutoff met; shows also ended with every monitored episode on disk. Removes the entry
  with `deleteFiles=false`, never files.

## Rust conventions
- Virtual workspace, flat `crates/`. Every dependency version lives in the root
  `[workspace.dependencies]`, and crates use `foo.workspace = true`.
- Lints are set at the workspace level (clippy pedantic). `cargo clippy --all-targets` must be clean.
- Library crates use `thiserror` enums. Only `panda-server` uses `anyhow`, and it maps errors
  to HTTP in `error.rs`.
- SQL must be `&'static str` literals (sqlx 0.9 rejects runtime strings). Use the
  `item_columns!()` / `request_columns!()` macros with `concat!`.
- New migrations go in `crates/panda-db/migrations/NNNN_name.sql`. Never edit an applied one.
- `panda-server` is lib + thin bin, and routes get one module per area under `routes/`.
  Background work goes in `services/`.

## Metadata
- `panda-metadata` never touches the DB; `panda-server/src/services/metadata.rs` glues it in.
- Providers (`panda_metadata::providers`): TMDB always decides which title a file is; the extras
  (TVmaze: on/off, OMDb: admin's key, ratings; Fanart.tv: admin's key, posters/backdrops/logos) are looked up only by the TVDB/IMDb ids TMDB
  gives, never by name. Each provider's answers are stored apart (`provider_values`); the shown
  plot/episode text is picked per field by the admin's order (`metadata_order`, first real value
  wins, stand-ins like "Episode 5" lose) and per-provider switches (`provider_switches`).
  Re-picking needs no lookups and is coalesced (`providers::repick`). TMDB's answers always count.
  Ratings aren't ordered: every enabled source is shown. Extras are asked after each metadata
  pass (`per_pass`, `concurrency` from their `Spec`), then monthly; failures retry daily
  (`provider_fetches`).
  Adding a provider: a `Provider` variant + its `Spec` in `providers.rs` (name, about, credit,
  key or switch, supplies, ratings with short labels, `extra` for how it's asked and its
  switches; TMDB is the base, `extra: None`), and its client + lookup in `services/providers.rs`
  (`Extra`). Settings keys, the admin route (`/api/admin/settings/providers/{id}`), the admin
  card (and its "Set up TMDB first", from the server's `blocked_by`), the lookup loop, rating
  switches and the ratings sent to apps (TMDB's first) all follow the `Spec`. Titles' TVDB/IMDb
  ids are stored at matching (`metadata.imdb_id`/`tvdb_id`). User's own key only, official APIs
  only, show its credit.
- Episode orders: a show folder can be numbered by another of TMDB's episode orders (an
  "episode group": DVD, absolute, ...), chosen by hand on the Matches page (`episode_orders`,
  keyed like `season_matches`); `store_episodes` then numbers by the group (season = its
  `order`, episode = its `order` + 1). Episode providers (TVmaze) skip such shows.
- Matching must be tested against real-world names: macOS/SMB NFD Unicode, Radarr's `: -> -`,
  `[Group]` tags, romanization variants. Add a unit test for every miss you fix.
- Artwork is ordered like other data (posters, backdrops, logos): TMDB's answers are cache keys,
  other providers' are URLs downloaded once picked (`fetch_remote`, allowed hosts only, scaled to
  the drawn size). Home's logos use Fanart.tv's when it's first or TMDB has none (`extra_logo`).
- Images: only the sizes the UI draws (w342 posters, w1280 backdrops), stored as WebP
  (`ImageCache::with_webp`; JPEG only when ffmpeg lacks libwebp), served immutable.
  WebP `-compression_level 4` (6 took ~4 s per transparent logo). Headshots aren't waited on:
  `routes::images::promise` hands out the key and downloads in the background, and
  `/images/{key}` fetches a promised image on the spot if it's asked for first.

## Storage
- `data_dir` (keep: database, `secret.key`) and `cache_dir` (rebuildable: images, subtitles,
  previews, transcodes) default per OS (`config::default_dirs`; `$PANDA_DATA_DIR` /
  `$PANDA_CACHE_DIR` override, for Docker and Linux packages). Setting `data_dir` in panda.toml
  keeps everything in that one folder. Cache paths go through `Config::cache_dir()`, never
  `data_dir`. `cache_max_gb` (default 20; the admin UI's Storage card overrides it via the
  `cache_max_gb` setting) trims previews and subtitles oldest-first hourly
  (`services/cache.rs`); artwork is never trimmed.
- Packaging (macOS): `scripts/package-macos.sh` builds `target/dist/panda-<v>-macos-arm64.tar.gz`
  and fills the Homebrew formula template `packaging/homebrew/panda.rb` (bundles jellyfin-ffmpeg
  via `PANDA_FFMPEG`, `brew services` runs it; logs in `$(brew --prefix)/var/log/panda.log`).
  `--install` installs it from a local tap (`local/panda`). Homebrew needs no Apple signing.
  Every package bundles the jellyfin-ffmpeg pinned in `packaging/jellyfin-ffmpeg.txt` (version +
  sha256 per platform, read via `scripts/jellyfin-ffmpeg.sh`); `.github/workflows/jellyfin-ffmpeg.yml`
  opens a bump PR weekly. `PANDA_BIND` overrides
  `[server] bind`; `panda --version` / `--help`.
- Standalone macOS package (no Homebrew): `scripts/package-mac-standalone.sh` ->
  `target/dist/panda-<v>-mac.tar.gz` with `packaging/macos/{install,uninstall}.sh`: installs to
  `~/Applications/Panda`, a launchd agent `local.panda.server` (`~/Library/LaunchAgents`), log in
  `~/Library/Logs/Panda`.
- Mac installer: `scripts/package-mac-pkg.sh` -> `target/dist/Panda-<v>.pkg` (unsigned, by choice;
  `packaging/macos/pkg/`): `/Applications/Panda` (server, `panda-agent` wrapper, ffmpeg,
  "Uninstall Panda.command"), LaunchAgent `/Library/LaunchAgents/local.panda.server.plist` run in
  the signed-in user's session (data in their `~/Library/Application Support/Panda`, log in
  `~/Library/Logs/Panda`). postinstall replaces the per-user install.sh copy, restarts the agent
  and opens the setup page.
- Linux: `scripts/package-linux.sh amd64|arm64` -> `.deb`, `.rpm` (nfpm, `packaging/linux/`) and a
  tarball: a static musl server (cargo-zigbuild, also from macOS) + jellyfin-ffmpeg in
  `/usr/lib/panda/ffmpeg`, systemd `panda.service` as user `panda`, data `/var/lib/panda`, cache
  `/var/cache/panda`. Upgrades never touch the data; remove keeps it, deb purge deletes it. The
  maintainer scripts take both dpkg's and rpm's arguments. `packaging/linux/test-upgrade.sh`
  checks upgrade/remove/reinstall/purge on a real Ubuntu. Docker: `packaging/docker/Dockerfile`
  (Debian slim + VA-API drivers, `/config` + `/cache`), from the Linux tarballs.
- Releases: tag `vX.Y.Z` (= Cargo.toml) -> `.github/workflows/release.yml` builds the UIs once,
  Linux + macOS packages, runs the upgrade test (from the previous release's .deb), publishes the
  GitHub Release (+ `panda.rb`, `SHA256SUMS`) and `ghcr.io/<owner>/panda`.
  The server stops gracefully on SIGTERM (launchd/systemd/Docker) as well as Ctrl-C.
- The TV app in a browser is served by the server at `/tv/` (`pnpm build:server` in clients/tv:
  base `/tv/`, `VITE_SERVED_BY_PANDA` makes the app's server its own origin, no Connect screen),
  embedded like the admin UI (`build.rs` -> `$OUT_DIR/tv`, `routes/web.rs` `serve_tv`, its own CSP
  allowing blob: media and workers). `scripts/build-release.sh` builds it.
  Opened in a browser signed in to Panda (the web's cookie session), it sets itself up from
  that: `POST /api/auth/device/from-browser` pairs a device of that account like a TV password
  sign-in, only from a cookie session (never a token) and same-origin (CSRF check); else the TV
  sign-in screen. Never signed in just for being on the local network.
- `panda bench [--max N] [--seconds S]` (`src/bench.rs`): how many streams this machine serves at
  once, with library files (4K repackaged, 1080p and 4K re-encoded, 4K HDR tone mapped) and the
  server's own pipeline and HLS arguments; a count passes when every stream keeps 1.1x real time.
  Also prints ffmpeg's hardware, encoders and tone mapping. Read-only (temp output in the cache).
  The admin UI runs it too (Settings > Performance; `services/bench.rs`, `/api/admin/bench`): in the
  background, one at a time, refused while anyone streams; the last report is kept
  (`bench_report`, the CLI saves its run there too) and its suggested hardware limit (one below the
  fewest re-encodes to 1080p that kept up) can be applied: `max_hardware_encodes`, applied at once
  (`Sessions::set_hardware_limit`) and at start, over panda.toml's `[transcoding] max_hardware`.
- Development: `scripts/dev.sh` starts the server and the live-reloading admin UI (the TV app
  separately: `pnpm start` in clients/tv; the web app: `pnpm dev` in clients/watch).

## Admin web UI (clients/web)
- Bundled into the server binary: `crates/panda-server/build.rs` copies `clients/web/dist` (minus
  source maps) into `$OUT_DIR/web`, embedded by `routes/web.rs` (rust-embed). One program serves
  the UI at `/` and the API at `/api`. `[server] web_dir` overrides with a folder. Release builds:
  `scripts/build-release.sh` (builds the UI first). A stale dist is embedded as-is, so rebuild the
  UI before a release; in development use `pnpm dev` (:5174).
- **Solid 2.0** (`solid-js` 2, `@solidjs/web`, `@solidjs/router` 2, `@solidjs/vite-plugin`).
  Read `node_modules/solid-js/CHEATSHEET.md` before writing code: Solid 2 is not 1.x.
  Key rules: async data = `createMemo(() => api.x())` under `<Loading>`, `refresh(memo)` after
  writes; never read props/signals at the top of a component body (seed local state with
  `createSignal(() => props.x)`); writes only in event handlers; `class={[..., {..}]}` arrays.
- Same-origin cookie auth. In dev, Vite proxies `/api` with `changeOrigin: false` so the
  server's Origin/Host CSRF check passes. Never store tokens in JS-readable storage here.
- Plain `<a href>` links (the router intercepts them); `data-active` styles the nav.
- Colors are the TV app's palette as CSS variables in `styles.css` (gold accent, warm neutrals;
  `--link` is a deeper gold for text on light backgrounds). Keep the two in step.

## Platform contract (all apps)
- Flows are the TV's everywhere: the avatar opens the Who's watching page (Back returns; editing
  a profile, About and signing out are there, no profile menu), launch picks a profile first when
  the account has several (`landingPath`), editing yourself needs no switch or PIN. Overlays are
  only where the TV has them, in each platform's own form (the TV's Dropdown = a menu, its
  season panel = a sheet, PinEntry = the PIN prompt, ConfirmDialog = a confirm).
- What an app needs from its platform is typed once in `clients/tv/src/platform/types.ts`
  (`PlaybackProfile`, `Discovery`, `Voice`, `NowPlaying` with `nowPlayingInfo()` for the wording,
  `Notifications`: no app shows any yet; push needs server work first). Each client answers it: the TV's
  `DeviceConfig` (`tv/devices/devices.ts`, one folder per target), the phone's `platform.ios.ts` /
  `platform.android.ts` (`satisfies PhonePlatform`, `app/platformTypes.ts`; screens import only
  `./platform`; also `prompt` for one-line questions, a PIN hidden on the number pad, and
  `deviceName`), the web app's `src/platform/`. Optional capabilities left out turn their feature
  off (the TV apps have no `nowPlaying`: TVs have no lock screen).
  A new platform implements the object and the type check lists what's missing.
- Everything kept on a device goes through `clients/tv/src/platform/settings.ts` (`SETTINGS`,
  `audioChoice()`, `read`/`write`; typed, storage failures swallowed). Never call `localStorage`
  directly and never rename a key (devices have them).

## TV client (clients/tv)
- SolidJS on SolidTV: `@solidtv/solid` (1.7) + `@solidtv/renderer` (2.x). The same source
  runs on Apple TV via NativeScript (clients/appletv). Renderer 2.x always draws with WebGL and
  SDF text (no `renderEngine`/`fontEngines`); shaders come from `@solidtv/renderer/shaders`,
  `HashRouter` from `@solidtv/solid/primitives/router`.
- WebGL, not DOM: no `div`/CSS. Colors are `0xRRGGBBAA` numbers from `src/theme.ts`.
- Look: near-black with warm whites and a champagne-gold accent (`theme.ts`), black scrims
  over art, focus = white fill + dark text, the accent for primary actions (`PillButton
  primary`) and selected states. Glass via `theme.glass` + `glassEdge()` (no blur). Radii only
  from `theme.radius` (buttons/chips sm, inputs/rows md, panels lg); circles only for avatars
  and icon buttons. Never hard-code a color or radius in a component. Spacing likewise:
  `theme.space.item` (40) between things side by side (buttons, chips, tabs, cards: room for a
  focused one's grow and ring), `theme.space.block` (48) between a page's stacked parts and in
  grids, `theme.space.list` (24) between rows of a settings list or form (pages start at
  `screen.gutter`); text inside a block keeps its own line spacing. Textures are cached by
  URL and an SVG is rasterized once at its first node's size: add `?s=<size>` per drawn size
  (Avatar). Round images get `borderRadius` so the edge is smoothed.
- Fonts: Roboto Regular/Bold MSDF atlases with ASCII + Latin-1 + Latin Extended-A + typographic
  punctuation (331 glyphs, one 1024x512 page each; made with @lightningjs/msdf-generator, the
  charset in `displayText()`'s DRAWABLE must match). Pass server/TMDB strings through
  `displayText()` (src/format.ts): it keeps what the fonts draw and drops the rest (CJK).
- Resolutions: 720p and 1080p. Lay out on the 1920x1080 grid only; `devices/resolution.ts`
  picks the output and the renderer scales (`deviceLogicalPixelRatio`). 1080p when the window fits
  1920x1080, else 720p (never smaller); in a browser the canvas is centered horizontally (kept at
  the top, index.html) and the player's `<video>` is sized to the canvas, not the window. Never hard-code
  physical pixels. Test with `?res=720` / `?res=1080`.
- Layering: `<video>` z-index 0, Lightning `<canvas>` z-index 1 (index.html). Only `<html>`
  gets a background; a `body` background would paint over the video. Pages that play video
  keep the app backdrop transparent.
- Performance: use `VirtualRow`/`VirtualColumn` for lists. Toggle `alpha` on frequently
  changing overlays instead of mounting/unmounting them. shaka-player and the Player page are
  lazy-loaded, so keep them out of the main bundle.
- Text is batched into one pass drawn after shapes. An overlay (menu, dialog, sheet) must set
  `zIndex` on its own filled nodes (not just a wrapper) so page text doesn't draw on top of it.
- Navigation: one `TopBar` (avatar -> Who's watching, Search, Home, a tab per library by its name,
  clock; more than 5 tabs: a window of 5 that slides with focus) on every
  page, tabs included (from a title, show, person or genre page, Up reaches Home: the way out);
  no sidebar. Pages open each other through `nav.ts`'s `useNavigate`: opening a title, show,
  person, preview or genre page already in the trail (kept per history entry by the router's
  `_depth`) goes back to it instead of stacking a copy, so the trail never loops. Up from a page's top and the Menu key reach it
  (`focusTopBar`, src/nav.ts), its Down returns to the page; tabs replace history. Movies/Shows
  cover every library of that kind (a library's `kind`, set by the admin; its name and folders
  are the admin's): `/movies` `/shows` are browse pages laid out like a genre page
  (`BrowsePage`, server `/api/browse/{kind}`: Featured, Top 10, Recently added, a row per main
  genre), and "All movies"/"All shows" opens the grid (Library, `/movies/all` `/shows/all`) with
  a Library chip when there are several. Lists must mount with their data (`<Show when={data()}>`) or `autofocus`
  lands on an empty container.
- Genre page (`/genre/{name}`, pages/Genre.tsx; server `routes/genre.rs`, `/api/genres/{name}`):
  from the library (catalog) alone, movies and shows together: the name over a tinted backdrop
  with "See all" (the filtered Movies/Shows grid), Featured (tall cards, half newest, half best
  rated, daily pick), a ranked Top 10 (`CardRow ranked`, `rank` per card), Recently added, and
  rows for the genres most often paired with it. Home's genre tiles open it.
- Shared building blocks (reuse, don't re-lay-out): `SeasonPicker` (Request and "More seasons"), `PageRows` + `HeaderArea` (scrolling page:
  header then rows), `TitleHeader` (title/meta/overview above pill buttons, flex-stacked),
  `HeroCarousel`, `PillButton`, `Card`/`CardRow`, `Backdrop`, `Avatar`, `TopBar`, `Keyboard` /
  `NumberPadSheet`, `PinEntry`, `ConfirmDialog`, `Dropdown` (menus drop from their chip),
  `IconButton` (round, named on focus), `Tab` (underlined page tabs; gold is for actions),
  `PeopleRow`, `DetailsPanel`. The movie page is one scrolling page (no tabs): a hero (logo via
  `TitleLogo`, `MetaLine` facts with rating badges, credits on the right), then its series
  (`/api/titles/{id}/collection`), More Like This, Cast & Crew, and `InfoSection` (About,
  Information, Languages from the file's tracks). Show pages are laid out the same way: the
  hero (what's next, credits "Created by"), then `EpisodesSection` (season tabs over a row of large
  episode cards; TMDB's `next_episode` greyed at the end of its season with its date, or in the
  meta line when its season isn't in the library), More Like This, Cast & Crew, `InfoSection`
  (each page passes its own Information/Files facts). Ratings get their own line under the facts.
- While video plays the screen stays on: `DeviceConfig.keepAwake` (`src/playback/awake.ts`, the
  player's play/pause/close): Samsung `webapis.appcommon.setScreenSaver`, Apple TV's idle timer,
  Android TV's window flag (`PandaScreen`), else the browser's Wake Lock (LG, browsers).
- Out of sight (Home, another app, the TV asleep): `src/lifecycle.ts` (`onAppVisibility`) from
  `visibilitychange` (browsers, LG, Samsung) or the hosts' `pandaSetHidden` (Apple TV's
  suspend/resume, Android TV's onPause/onResume). The player saves and pauses (back again: paused,
  controls up; a stream the server ended meanwhile restarts where it was), preview clips stop.
- Back (`b`/Backspace/Escape; LG 461, Samsung 10009) is handled at the app root: previous page,
  except on main pages: the top bar first, then Home (Home stays). Overlays handle `onBack`
  themselves and return true.
  Back restores where you were (`focusMemory.ts`, keyed by page address): PageRows the focused
  row, CardRow the focused card (rows told apart by title), Library its grid's title, sort and
  filter. Only a return by Back restores; a page opened afresh starts at the top.
- Every list that can grow uses a virtual primitive (`CardRow` = VirtualRow, Library =
  VirtualGrid). Never `For` an unbounded list of rows; e.g. seasons are tabs + one row.
- Event handlers (`onSelectedChanged`, `onFocusChanged`, key handlers) stop propagation when
  they return truthy. Use a block body for side effects: `(i) => { setX(i); }`, never
  `(i) => setX(i)`, or a Column/Row stops scrolling.
- TV sign-in: username and password on the TV (`/api/auth/device/login`, the web login's checks
  and limits via `check_password`, pairing via `pair_device`); a link code approved at `/link`
  is the alternative. Password-less profiles can never sign in.
- Auth: the TV keeps a device credential (`panda.device_secret`, lists/switches profiles) and a
  profile session. A revoked session goes to `/profiles`; a revoked device goes to `/link`.
- Device builds: `#device` resolves to `devices/<TARGET_DEVICE>` (common, lg, tizen, android);
  `pnpm package:<device>` builds with relative paths and packages it (docs/DEVICES.md). Packaged
  apps get the server address from the Connect screen (`api/server.ts`), never a build constant.
  The Connect screen offers servers found on the network first (`api/discover.ts`): the server
  announces `_panda._tcp` by mDNS (`services/discovery.rs`, `[server] advertise`, default on) and
  answers public `/api/info`; each device's `DeviceConfig.discover` gives names found by Bonjour
  (Apple TV, `clients/appletv/app/discovery.ts`) or NSD (Android TV, `MainActivity.Discovery`), or
  the TV's own address (LG: webOS connection manager; Samsung: `webapis.network.getIp`), whose
  /24 is scanned for `/api/info`. Every found server is checked before it's offered.
- Player: Subtitles and Audio buttons only when there's a choice (any subtitles; 2+ audio tracks);
  an audio choice restarts playback with `audio_index` (copied, or converted when the TV can't
  play it), remembered per title on the TV. Visible controls always hold focus (seek bar above a button row); the page itself
  only handles keys while they're hidden. Scrub previews: playback's `preview_url` with
  `{secs}` filled in (playback/trickplay.ts), requested once scrubbing settles.
- Search (`pages/Search.tsx`, server `routes/search.rs`): `/api/find` always searches the library;
  "more" (not in library) comes from Radarr/Sonarr lookup only when that server is set up.
  Results are one Movies and one Shows row (yours first, then requestable ones, badged) and
  People (`/api/find/people`, TMDB person search, cast-shaped; first when the query is the best
  match's name). TMDB has no character search.
  Empty screen: Top picks (`/api/find?picks=true`) and `/api/discover` rows (TMDB trending and
  "Popular on <service>", region from `[tmdb] region`, cached 6 h, minus the library).
  Typing pages use `components/Keyboard.tsx` (on-screen grid + `useTypedInput` for real keys).
- Title details (`/api/titles/{id}/details`): TMDB `movie_full` (credits + release dates) fetched
  on first view, cached in `title_details` (30 days), headshots via `ImageSize::Profile`.
  `/api/titles/{id}/suggestions`: TMDB recommendations not in the library, requestable (only
  with TMDB + Radarr). Both follow the title's library access.
  Titles you don't have open a full page, `/discover/{kind}/{tmdb_id}` (pages/Preview.tsx, laid
  out like an owned title's: logo, ratings, film series, More Like This, Cast & Crew, About and
  Information, Request in place of Play; TMDB part cached 6 h, the rest per profile), from More Like This and
  Search alike; it redirects to the real page when the title is in the library.
  People (Cast & Crew) open `/person/{id}` (`/api/people/{id}`, TMDB combined credits, cached
  6 h), laid out like a title's page: photo, name, facts, the start of the biography
  (Biography opens it all) over a backdrop from a title where they have a big part (billing
  order, `lead_tier`; never a cameo's). Rows: theirs in your library (big parts first), then
  their other work by role (`role_of`: Movies, Shows, Directed, Written, Produced, Guest
  appearances; their own department first), minus self-appearances and talk/news/reality.
  Tab content starts `theme.tabContentTop` below a page's tab bar (all tabs alike).
  Show pages: More Like This from `/api/series/{name}/suggestions`, Cast & Crew and facts from
  `/api/series/{name}/details` (also status, next episode to air, logo, languages).
  Episode thumbnails are TMDB stills, fetched into the image cache when a show's episodes are
  listed (`episode_stills`, waits 4 s, the rest finish in the background).
- Pointer mode (Magic Remote): fades at the bottom edge and under the top bar appear only while
  something is off screen (or partly) that way (`scrollableDirections`). Clicking selects the
  nearest such item as if chosen (`pageScroll`): a section of a plain list via that list's own
  onUp/onDown, an item in a virtual list via `scrollToIndex` (or stepped Up/Down, spaced
  `STEP_MS`, when the list already has focus: its window rebuilds between steps). Hover focuses only after the
  pointer rests `HOVER_FOCUS_MS` (crossing Home's cards no longer opens them). Rows get side fades at
  their height while an item past the focused one is cut off (`rowScrollState`); a click is
  one Left/Right (`rowScroll`), so the row brings in one more item. Text ignores a parent's clipping when nested
  in another clipped view: cover the area outside a scrolling window with a zIndexed panel.
- Requests: Radarr/Sonarr each have an HD server and an optional 4K one (`radarr_4k`,
  `sonarr_4k` settings; `Integrations::radarrs()/sonarrs()`); a request goes to every server of
  its kind. Requests belong to a profile; `/api/requests/mine` adds live per-server progress
  (`panda_arr::progress`), shown at the front of the TV's My List.
- Voice search (`src/voice.ts`): one entry point, `startVoiceSearch`, opens `/search?q=...` from
  any screen (Voice key; Search has a Voice key too). Browser uses the Web Speech API; LG/Samsung
  remote mics are to be added as further sources when testing on real TVs.
- UI text: wrap in `t("English text")` (src/i18n.ts; Spanish table there, English is the key).
  Language: the profile's `language` (Edit profile), else the device. Avatars: bundled SVGs in
  public/images/avatars; the id list is in Avatar.tsx and `AVATARS` in routes/auth.rs (keep in sync).
  Or `art:<image key>`: the poster of a title the profile can see (Edit profile's "From your
  library"; checked by `avatar_allowed`), drawn cropped to the circle.
- Performance tiers (`devices/tier.ts`, `perf`): low/high decided once at startup (UA, RAM,
  cores; `?tier=` or the stored `panda.tier` override). Renderer options, animations, list
  buffers and hero auto-advance read `perf`; new costly features should too. Apple TV: Menu on
  Home is left unhandled (`exitOnRootBack`) so tvOS exits the app; the host sets
  `Config.preventDefaultOnHandledKeys`.
- Dev server base path is `/common/` (set per device by `devices/deviceConfigPlugin.ts`).

## Web app for watching (clients/watch)
- The TV app's pages and player for phones, tablets and computers in a browser, served by Panda at
  `/watch/` (`build.rs` -> `$OUT_DIR/watch`, `routes/web.rs` `serve_watch`, its own CSP with blob:
  media for shaka-player). `pnpm build:standalone` for hosting elsewhere (Connect + password
  sign-in, bearer tokens over CORS). Linked from the admin sidebar ("Watch", `rel="external"`).
- Solid 2 DOM (the admin UI's stack); shares the TV's non-UI code as source (`@tv` -> `../tv/src`,
  `solid-js` deduped to Solid 2, TV-only imports answered in `src/shims`). Built after the TV app
  (`scripts/build-release.sh`, release.yml).
- Signs in like the TV app in a browser: a device credential plus a profile session in
  localStorage, from the browser's Panda cookie (`from-browser`) or username and password;
  Who's watching, PINs, Edit profile as on the TV. Sign-in and Who's watching return to `?next=`.
- Pages are real URLs under the base: links carry it (`href(path)`), and `go(path)` adds it
  (the router's navigate doesn't); the router's `location.pathname` includes it (`appPath`).
- Breakpoints 600/900/1280/1800 as CSS variables (`styles.css`); below 900 bottom tabs, above it
  the TV's top bar (Home, a tab per library, My List). Mouse-only effects under `(hover: hover)`.
- Player (`src/player`): `<video>` + shaka for HLS (native HLS without Media Source), the TV's
  `planSeek`, `StallMonitor`, recovery and progress rules (the phone's player logic); a tap shows the
  controls and the click that follows is swallowed (`revealedAt`). Full screen is the whole page
  (menus are drawn outside the player).
- Every new word: `t()` with a Spanish entry in `../tv/src/i18n.ts` ("Web app" section).
- Motion only on `transform`/`opacity`, all in CSS (no transitions on size, position, clip,
  colour or shadow; no `backdrop-filter`: over a playing clip it re-blurs every frame). Things that
  move are on their own layers from the start (`will-change` on cards, headshots, expanding cards):
  a layer made when the first card moves splits the row and repaints all of it. No scroll snapping
  with a mouse (`(hover: hover)`): a moving snap target repaints its row every frame. The expanding
  row is a track of fixed-size cards: the open card's wide part fades in while the cards after it
  slide (`transform`); backdrops are fetched ahead (lazy loading never fetches a hidden picture).
  Rows off screen use `content-visibility: auto`; a season's episodes skip each item off
  screen; the All grid and My List are virtual (`components/VirtualGrid.tsx`) with rows keyed by row number (keyed by position,
  every row switches titles and repaints when the window moves). Fixed/sticky bars, hero slides,
  grid rows and the player's controls are layers; the player's clock and scrub bar only update
  while the controls show. Not layered: shadows (`::after`) and the All grid's cards (layers there
  are re-made as rows come and go). Measured with Chrome traces (hovering a row 120 -> 40 paints,
  scrolling the grid 1629 -> 485, the idle player 41 -> 3).
- Spacing from tokens only (`--space-item/block/list/text`, the 4 px scale, `--page-top`), as the
  TV's `theme.space`; no spacing in inline styles.

## Phone app (clients/mobile)
- NativeScript 9 + SolidJS 2 via `@nativescript-community/solid-js` (native iOS and Android views,
  one project; OS code in `*.ios.ts` / `*.android.ts`, gathered in `platform.<os>.ts`). Not the TV app's SolidTV canvas: phones need touch and portrait layouts.
- Shares the TV client's non-UI code as source: webpack alias `@tv` -> `../tv/src` (api, session,
  discover, i18n, types) and `@appletv` -> `../appletv/app` (Bonjour). Browser/TV globals that code
  reads are answered in `app/shims/` (`localStorage` = ApplicationSettings, `#device`,
  `#devices/debug`). Solid 2 here, Solid 1.9 in the TV app: shared code may only use
  `createSignal` plain values (both versions agree on that).
- Screens are native pages (`app/nav.ts` `open()`: a Solid tree per page, disposed when the page
  is gone). Sign-in screens use the root Frame; signed in, the root shows a TabView (`app/tabs.tsx`:
  Home, Movies, Shows, Search), one Frame per tab, and `open()` pushes onto the selected tab's.
  Links between screens live in `app/screens/links.tsx`.
- TV parity pieces: hero carousel (`screens/Hero.tsx`) on Home/Movies/Shows; preview clips
  (`clip.<os>.ts`, `platform.clips.play` returns a handle: stop only your own clip; none while the player is
  open, only the sheet's while a sheet is); Recently Added rows have a fixed focus spot at the left (`ExpandRow`:
  one layout function of a fractional spot position drives drag and settle alike (sizes follow the
  finger; the settle is our own 60 fps ease-out: NativeScript's width animation grows views about
  their centre and wobbled); a sideways-only UIPanGestureRecognizer; not a ScrollView. Check motion
  with `-pandaDrag <points>` + `simctl io recordVideo` and look at the frames. Tapping a poster
  opens its page (no preview sheet: the user wants straight to the info). `openSheet` is for
  pickers (seasons).
  Logos go through `Logo` (iOS centers a picture in its box: the box takes the logo's shape).
  Text over artwork: black scrims plus text-shadow. A GridLayout inside a StackLayout needs
  `rows="auto"`, or its default star row takes spare height. Styling is CSS classes in `app/app.css` (the TV palette); inline
  `style=` strings don't apply with this renderer. Events are `on:tap`, `on:returnPress`.
- Long lists: the All grid and My List are real virtual lists (`app/virtual.tsx` `createVirtualList`: a
  ListView/UITableView, cells built once from the renderer's `document.createElement` and handed new
  items on reuse; set `rowHeight` after the class or it stays "auto"; `"auto"` for rows of different
  kinds, as My List's headings, requests and poster rows). Rows inside a scrolling page
  can't be a table: long ones are paged ("Show more", episodes 40 at a time). Server rows are capped.
- Speed on device (checked in a full review): run Release builds on the phone
  (`scripts/run-device.sh`; Debug is 5.6 MB of unminified JS with Solid's dev checks); every
  `<image>` gets `loadMode="async"`; `NSURLCache` is 50 MB/300 MB (app.tsx); tabs are built on first
  open and released on sign-out/profile switch (`setBeforeRootReset`); lists keyed by a stable id
  (`MoreRow` `keyed={keyOf}`, virtual cells `keyed={false}`), row items in `createMemo`, never
  `.map` in JSX props that are read on gestures; native gesture recognizers attached once and
  removed on cleanup; timers/pollers stop when signed out, off screen or in the background;
  big images only near what's shown (focus row backdrops); clips use the Ambient audio session,
  the player takes Playback and releases it on close; shared stores for My List, requests and
  libraries (`refreshHooks`) instead of a fetch per page. Search waits for typing to pause
  (700 ms, 2+ letters) and draws results only when idle.
- Loading states: ghosts, as the TV's GhostRow (`GhostRow`, `GhostHero` in `screens/cards.tsx`, the
  `.ghost` pulse in app.css) hold a page's shape until its data arrives; no spinners on content pages.
- Android: Media3 ExoPlayer (`media3.android.ts`, a TextureView; playback starts only once its
  surface exists: a decoder switched to it mid-stream may keep drawing into the stand-in, a black
  picture with sound). Lock screen / notification / headphone controls: `nowPlaying.android.ts`
  (a Media3 MediaSession over `SessionPlayerBase`, the one Java file,
  `App_Resources/Android/src/main/java`: SimpleBasePlayer's constructors and State are protected,
  out of NativeScript's reach; its buttons go through the player's own seek) hosted by
  `PlaybackService` (MediaSessionService, foreground while playing, in the manifest). Leaving the
  app keeps the sound, or (Android 12+) the picture in a picture-in-picture window (no controls or
  text subtitles); closing that window pauses. Everything else stays TypeScript: NativeScript
  generates the Java stubs for `.extend(...)` classes. NSD discovery, SpeechRecognizer, SF Symbol names as vector drawables
  (`res/drawable/sym_*.xml`). Build: JDK 17 + `ANDROID_HOME`, `npx ns build android`.
- Playback (`player.ios.ts`; `player.android.tsx` alike): our own controls over an AVPlayerLayer, never AVPlayerViewController
  (it shows the server's growing HLS event playlists as "LIVE" with no seeking ahead). The
  timeline is the file's length; seeks go through the TV's `planSeek` (restart outside the
  stream). Subtitles drawn over `layer.videoRect` (`app/subtitles.ts`, the TV's windowed/file/PGS
  loading and `@tv/playback` parsers); Subtitles/Audio/Quality are native action sheets. Background:
  the AVPlayerLayer drops the player on `backgroundEvent` (else iOS pauses it), Now Playing +
  remote commands (`MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`), all removed on close. A build
  whose Xcode step was cut short can be unsigned or stale: `scripts/run-sim.sh` refuses an
  unsigned app.
- Solid 2 refuses signal writes while a component is being built (REACTIVE_WRITE_IN_OWNED_SCOPE, a
  fatal error that leaves a black screen): start work that writes from a timeout, a promise or
  an event. The JS engine has no Intl/locale data: language names come from iOS
  (`Intl.DisplayNames` shim in `app/shims/globals.ts`), dates are formatted by hand (`data.ts`).
- Checking screens: `scripts/run-sim.sh [udid] [out] [secs] -pandaOpen title:<id>` and
  `-pandaScroll <points>` (debug builds; `app/devLaunch.tsx`). `pnpm typecheck` (JSX types: `app/jsx.d.ts`).

## Logo (clients/brand)
- Sources: `panda-mark.svg` (panda in front of an orange play triangle; groups `#play` and
  `#panda`) and `panda-wordmark.svg` ("Panda" in Fredoka Bold as outlines, a play in the "a").
- `pnpm icons` in clients/brand renders every app icon from them (committed outputs): Apple TV
  layered icon + Top Shelf (`appletv/App_Resources/tvOS/Assets.xcassets`; triangle and panda
  are separate parallax layers), LG, Tizen, Android TV launcher + banner, the admin UI's
  favicon, the iPhone app's icon (`clients/mobile/App_Resources/iOS/Assets.xcassets`). Never edit those PNGs by hand: change the SVGs or the script and rerun.
