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
Who's watching, then a tab bar (`app/tabs.tsx`): Home (as on the TV: featured titles to swipe,
Continue Watching, My List, holiday and themed rows, recently added, genre tiles, a spotlight,
top picks), Movies and Shows (`/api/browse/{kind}`: Featured, Top 10, Recently added, a row per
genre, and "All" as a poster grid), Search (`/api/find`, top picks before typing). Genre pages
are laid out like Movies. A movie's page, and a show's (seasons and episodes). Each tab has its
own Frame (`app/nav.ts`), so it keeps its own history, with iOS's navigation bar and swipe back.

Playback (`app/player.ts`): the server plans the stream for this device (`app/profile.ts`:
MP4/MOV with H.264/HEVC direct, the rest remuxed to HLS) and AVPlayerViewController plays it with
iOS's controls, AirPlay and Picture in Picture. Progress is saved every 10 s and on close, so
resume and Continue Watching follow you between the phone and the TVs.

Subtitles and audio (`app/subtitles.ts`): iOS's player has no place for our own menus, so a tap
also shows an "Audio and subtitles" button (under iOS's mute button) that opens native menus.
Subtitles are drawn over the picture (`contentOverlayView`), loaded as the TV loads them: built-in
text tracks in 10-minute windows (`?from=`), subtitle files whole, image (PGS) tracks from the
manifest the server fills in as it extracts them, placed where they were authored. Parsing and
labels are the TV's (`@tv/playback/*`). The subtitle language is remembered across titles (else a
forced track in the audio's language shows); the audio track per title (the TV's key). Another
audio track restarts the stream there, as on the TV.

Not yet: subtitle timing, requests, people pages, My List editing, avatars, Android.

## Running

```sh
pnpm install
. scripts/env.sh && npx ns build ios --emulator    # Ruby/CocoaPods env as in clients/appletv
scripts/run-sim.sh                                 # boot an iPhone simulator, install, screenshot
scripts/run-sim.sh "" ./sim-out 8 -pandaOpen title:m11423   # debug builds: open a screen
pnpm typecheck
```

`-pandaOpen` (debug builds only, `app/devLaunch.tsx`): `title:<id>`, `series:<name>`,
`genre:<name>`, `all:movies|shows`, `tab:<0-3>`, `profiles`, `signin`, `connect`,
`play-title:<id>`, `play-item:<id>[@<secs>]`; `-pandaScroll <points>` scrolls the page down. On your own iPhone: open
`platforms/ios/Panda.xcworkspace` in Xcode, pick your team and the phone, Run (free Apple
accounts' builds last 7 days; TestFlight and the App Store need the paid program).
