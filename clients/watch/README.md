# Panda web app (clients/watch)

Watching Panda in a browser on a phone, tablet or computer: the TV app's pages (Home with its
hero and expanding rows, Movies, Shows, each library, genres, the All grid, a movie, a show, a
person, titles you don't have with Request, Search with voice, My List, Who's watching, Edit
profile, About) and its player, laid out for touch and mouse at every width.

- Solid 2 DOM app (`solid-js` 2, `@solidjs/web`, `@solidjs/router` 2), like the admin UI. Read
  `node_modules/solid-js/CHEATSHEET.md` before writing code.
- Shares the TV app's non-UI code as source: `@tv` -> `../tv/src` (API client, sessions, playback
  rules, subtitles, translations, voice search, library sorting). The few TV-only modules it
  imports are answered in `src/shims` (`#device`, `#devices/resolution`). `solid-js` is always this
  app's Solid 2 (`dedupe`; the TV's own copy is Solid 1), so shared code may only use plain
  `createSignal` values.
- The TV's avatar pictures and TMDB logo come straight from `../tv/public/images` (a Vite plugin
  serves them in dev and emits them on build).

## Builds

- `pnpm build`: served by Panda at `/watch/` (bundled into the server binary by
  `crates/panda-server/build.rs`, like the admin UI and the TV app). A browser signed in to
  Panda's web pages sets itself up from that sign-in (`/api/auth/device/from-browser`), as the TV
  app does in a browser; otherwise it asks for a username and password. Either way the browser
  becomes one of the account's devices (Who's watching, profiles, PINs).
- `pnpm build:standalone`: hosted anywhere else (`WATCH_BASE` sets its base path, default `/`);
  it asks for the server's address first (Connect), then a username and password. The API allows
  bearer tokens from other origins (CORS without credentials). Serve `index.html` for unknown
  paths (history routing).
- `pnpm dev`: http://localhost:5175/watch/, `/api` proxied to `$PANDA_SERVER` (default
  http://localhost:8096). Sign in to the admin UI on that server first, or use a username and
  password.

## Layout

Breakpoints (`src/styles.css`): below 600 px phones, 600 small tablets, 900 tablets (the top bar's
tabs replace the bottom tabs), 1280 laptops, 1800 big screens. Card, row and type sizes are CSS
variables set per breakpoint; there's no per-device code. Hover effects only where there's a
mouse (`(hover: hover)`); the expanding row opens on hover, on focus, or on a first tap.

## Player

`src/player`: a `<video>` with our own controls. Direct play by URL; HLS through shaka-player
(loaded on first use) where the browser has Media Source, natively elsewhere (older iPhones).
The TV's rules: seeks outside an HLS session restart it (`planSeek`), buffering steps the
bitrate down (`StallMonitor`), a broken stream restarts where it was (three times a minute),
progress is saved every 10 s and on close, audio choice is remembered per title. Subtitles are
the phone's loader over the TV's parsers (text windows, subtitle files, image subtitles), with
per-track timing. Keys: Space/K, ←/→ (J/L), ↑/↓, M, F, C, Esc. Media Session for the system's
media controls; Picture in Picture and full screen where the browser has them.
