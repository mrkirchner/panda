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
Who's watching, then a tab bar (`app/tabs.tsx`; iOS-size labels, set in app.css): Home (as on the TV: featured titles to swipe,
Continue Watching, My List, holiday and themed rows, recently added, genre tiles, a spotlight,
top picks), Movies and Shows (`/api/browse/{kind}`: Featured, Top 10, Recently added, a row per
genre, and "All" as a poster grid), Search (`/api/find`; before typing, top picks and the TV's Trending / "Popular on <service>"
rows, requestable), My List (your requests with progress and Cancel, then saved titles). Home's
profile button: Edit profile, Switch profile, Sign out.

As on the TV: a hero carousel at the top of Home, Movies and Shows (`screens/Hero.tsx`: logo,
reason, facts, ratings, Play / More info, 9 s slides), preview clips behind it and behind a
title's page header (`app/clip.ts`: one at a time, quiet or silent per profile, none while the
player or a sheet covers them), the TV's expanding row for Recently Added (`ExpandRow` in `screens/cards.tsx`: the open card
shows its backdrop, name and facts, and its clip; a fixed focus spot at the left, as a TV row's focus:
swiping moves the titles through it, the open card closing as it leaves and the next opening
as it arrives; tapping a poster brings it there; tapping the open card opens its page), rating badges as the TV draws them (TMDB's logo, IMDb/RT/MC pills; `Ratings` in
`screens/sections.tsx`), left-aligned title logos (`Logo`). Tapping any other poster opens its page.tsx`, `nav.ts` `openSheet`). Genre pages
are laid out like Movies. A movie's page and a show's, as on the TV: logo, facts, ratings, Play or
Resume, My List / Watched / Versions / More seasons, episodes, film series, More Like This, Cast &
Crew, Information and Languages. People's pages, and pages for titles you don't have with
Request (seasons for shows) and Cancel; Search adds those titles and People; your requests lead
My List with their progress. Each tab has its
own Frame (`app/nav.ts`), so it keeps its own history, with iOS's navigation bar and swipe back.

Playback (`app/player.ts`): our own controls, as on the TV (iOS's player reads a stream the
server is still converting as live: "LIVE", no running time, no seeking ahead). The timeline is
the whole file (its length from `/api/items/{id}`); a seek outside what the stream has starts a
new one there (`planSeek`, the TV's). Close, title, AirPlay (`AVRoutePickerView`), Picture in
Picture on top; back/forward 10 s and play/pause in the middle; the scrubber with the server's
preview frames while dragging, the times, Subtitles, Audio and Quality (the TV's options, Auto
measures the connection) at the bottom. Landscape on phones. The server plans the stream for
this device (`app/profile.ts`). Progress is saved every 10 s and on close; the player closes at
the end. In the background the sound keeps playing (the layer lets go of the player unless Picture
in Picture took it), with Now Playing on the lock screen and Control Center (play/pause, skip,
scrub).

Subtitles and audio (`app/subtitles.ts`): native menus from the control bar. Subtitles, loaded as the TV loads them: built-in
text tracks in 10-minute windows (`?from=`), subtitle files whole, image (PGS) tracks from the
manifest the server fills in as it extracts them, placed where they were authored. Parsing and
labels are the TV's (`@tv/playback/*`). The subtitle language is remembered across titles (else a
forced track in the audio's language shows); the audio track per title (the TV's key). Another
audio track restarts the stream there, as on the TV. Subtitle timing (the TV's 0.1 s steps,
remembered per file and track) is in the Subtitles menu; its menu reopens after each nudge.

Avatars: the TV's SVG pictures become PNGs at build time (`scripts/rasterize-avatars.cjs`, iOS
draws no SVG); `art:<key>` avatars are library posters (`app/avatar.tsx`).

Profiles as on the TV: Who's watching adds profiles and has Edit profiles (signing in as the
profile first, PIN included); Edit profile changes the picture (initial or a library poster),
name, language, PIN, its own sign-in (emailed link), and deletes it. The icon comes from
brand (`pnpm icons`).

Not yet: Android.

## Running

```sh
pnpm install
. scripts/env.sh && npx ns build ios --emulator    # Ruby/CocoaPods env as in clients/appletv
scripts/run-sim.sh                                 # boot an iPhone simulator, install, screenshot
scripts/run-sim.sh "" ./sim-out 8 -pandaOpen title:m11423   # debug builds: open a screen
pnpm typecheck
```

On your iPhone: connect it (and trust this Mac), then `scripts/run-device.sh`: a Release build
(minified, Solid's production build; the Debug build Xcode's Run makes is several times slower:
5.6 MB of unminified JS with Solid's development checks, against 1.7 MB), signed with the team in
team.local (or ../appletv/team.local), installed and launched. `CONFIG=Debug scripts/run-device.sh`
for logs and the `-panda*` launch options. Or open `platforms/ios/Panda.xcodeproj` in Xcode
(no .xcworkspace: no CocoaPods) and Run, after `npx ns prepare ios --release` for a fast build.

`-pandaOpen` (debug builds only, `app/devLaunch.tsx`): `title:<id>`, `series:<name>`,
`genre:<name>`, `all:movies|shows`, `tab:<0-3>`, `profiles`, `signin`, `connect`,
`play-title:<id>`, `play-item:<id>[@<secs>]`, `person:<id>`, `preview:<kind>:<tmdb id>`;
`-pandaSearch <q>`, `-pandaSeek <secs>`; `-pandaScroll <points>` scrolls the page down. Free Apple accounts' builds last 7 days; TestFlight and the App Store need the paid program.
