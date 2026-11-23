# Panda for iPhone

The phone app: NativeScript with SolidJS 2 (`@nativescript-community/solid-js`) drawing real iOS
views, not the TV app's WebGL canvas. Android can be added to this same project later.

What it shares instead of copying:
- `../tv/src` (webpack alias `@tv`): the API client, sign-in and session, server discovery,
  i18n, types. The phone answers what that code expects of a browser or TV in `app/shims/`
  (`localStorage` in NSUserDefaults, `navigator.language`, `#device`, `#devices/debug`).
- `../appletv/app` (alias `@appletv`): Bonjour discovery (same iOS APIs).
- The TV palette, as CSS (`app/app.css`): keep the two in step.

Screens (`app/screens`): Connect (servers found by Bonjour, or an address), Sign in (username or
email and password, `/api/auth/device/login`: the phone becomes one of the account's devices),
Who's watching, Home (featured, Continue Watching, My List, recently added), a movie, a show
(seasons and episodes). Each screen is a native page on one Frame (`app/nav.ts`), so iOS gives
the navigation bar and swipe back.

Playback (`app/player.ts`): the server plans the stream for this device (`app/profile.ts`:
MP4/MOV with H.264/HEVC direct, the rest remuxed to HLS) and AVPlayerViewController plays it with
iOS's controls, AirPlay and Picture in Picture. Progress is saved every 10 s and on close, so
resume and Continue Watching follow you between the phone and the TVs.

Not yet: subtitles and audio track choice, search, browse pages, requests, avatars, Android.

## Running

```sh
pnpm install
. scripts/env.sh && npx ns build ios --emulator    # Ruby/CocoaPods env as in clients/appletv
scripts/run-sim.sh                                 # boot an iPhone simulator, install, screenshot
scripts/run-sim.sh "" ./sim-out 8 -pandaOpen title:m11423   # debug builds: open a screen
pnpm typecheck
```

`-pandaOpen` (debug builds only, `app/devLaunch.tsx`): `title:<id>`, `series:<name>`,
`profiles`, `signin`, `connect`, `play-title:<id>`. On your own iPhone: open
`platforms/ios/Panda.xcworkspace` in Xcode, pick your team and the phone, Run (free Apple
accounts' builds last 7 days; TestFlight and the App Store need the paid program).
