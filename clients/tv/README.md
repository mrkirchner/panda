# Panda TV client

10-foot UI for Panda, built with SolidJS on the SolidTV Lightning renderer (WebGL).
Bootstrapped from [lightning-tv/solid-starter-template](https://github.com/lightning-tv/solid-starter-template)
(see `LICENSE` / `NOTICE`).

```sh
pnpm install
pnpm start          # http://localhost:5173/common/  (keys: arrows, Enter, b = back)
pnpm build          # dist/common, or TARGET_DEVICE=lg|tizen pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

Set `VITE_PANDA_SERVER` in `environments/.env` if the server isn't on this host's port 8096.

```
src/
  api/          typed client for the Panda server
  playback/     codec detection (client profile), WebVTT parsing
  components/   Tile, Shelf (virtualized row), SubtitleOverlay
  pages/        App shell, Home, Player (lazy-loaded)
  theme.ts      design tokens
devices/        per-platform device + player (web, LG webOS, Tizen)
```

In the player: Enter or PlayPause toggles playback, Left/Right seek 10 s, Up cycles subtitles.
