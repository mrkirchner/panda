# Installing Panda on your TVs (sideloading)

The same TV app (clients/tv) is packaged for each platform. On first launch it asks for your
Panda server's address (for example `192.168.1.20`; `:8096` is added for you), then shows a
sign-in code to approve on your phone at `<server>/link`.

Before you start: the server must be reachable from the TV. `bind = "0.0.0.0:8096"` in
`panda.toml` (the default), and on macOS allow incoming connections for `panda` when asked.

All commands run in `clients/tv`. Packages land in `clients/tv/dist/packages/`.

## LG (webOS)

One-time setup:
1. Install LG's CLI: `npm i -g @webos-tools/cli`
2. On the TV, install the **Developer Mode** app from the LG Content Store, sign in with an LG
   developer account (free), and turn on **Dev Mode Status** and **Key Server**. Note the
   passphrase it shows. (Dev Mode expires after 50 hours unless extended in the app.)
3. Register the TV: `ares-setup-device --add tv -i "host=<TV IP>" -i "port=9922" -i "username=prisoner"`
4. Fetch its key: `ares-novacom --device tv --getkey` (enter the passphrase)

Each build:
```sh
pnpm package:lg
ares-install --device tv dist/packages/com.panda.tv_0.1.0_all.ipk
ares-launch --device tv com.panda.tv
```

## Samsung (Tizen)

Samsung only installs packages signed with your own certificate.

One-time setup:
1. Install **Tizen Studio** with the **TV extensions** (Package Manager: "Extension SDK" >
   "Samsung TV Extensions") and **Samsung Certificate Extension**.
2. On the TV: open **Apps**, press `1 2 3 4 5` on the remote, turn **Developer mode** on, enter
   your Mac's IP address, and restart the TV.
3. Connect: `~/tizen-studio/tools/sdb connect <TV IP>` and note the device name from
   `sdb devices`.
4. In Tizen Studio's **Certificate Manager**, create a **Samsung** certificate profile for **TV**
   (sign in with your Samsung account; it adds the connected TV's DUID). Note the profile name.

Each build:
```sh
TIZEN_PROFILE=<profile name> pnpm package:tizen
~/tizen-studio/tools/ide/bin/tizen install -n dist/packages/Panda.wgt -t <device name>
```

## Android TV, Google TV and Fire TV

One APK works on all of them (clients/android-tv wraps the TV app in a WebView).

One-time setup (build machine): a JDK 17, the Android SDK (`ANDROID_HOME`) and Gradle.

On the TV:
- **Android/Google TV**: Settings > System > About > press **Build** 7 times; then Developer
  options > **USB debugging** (and **Network debugging** where offered).
- **Fire TV**: Settings > My Fire TV > About > press the device name 7 times; then Developer
  options > **ADB debugging** on and **Apps from Unknown Sources** on.

Each build:
```sh
pnpm package:android
adb connect <TV IP>:5555        # accept the prompt on the TV the first time
adb install -r dist/packages/panda-android-tv.apk
```
Panda appears in the apps row (Android TV home / Fire TV "Your Apps & Channels").

## Apple TV

`clients/appletv` runs the same TV app on tvOS through NativeScript (`@solidtv/nativescript`):
no browser, the app's source bundled by webpack, the Siri Remote bridged to key events.

One-time setup: Xcode with the tvOS simulator, `brew install cocoapods` (NativeScript edits the
Xcode project with its `xcodeproj` gem), then `pnpm install` in `clients/appletv`.

Simulator:
```sh
cd clients/appletv
. scripts/env.sh                      # Homebrew Ruby + CocoaPods gems for the ns CLI
npx ns build tvos --emulator
./scripts/run-sim.sh                  # boots an Apple TV simulator, installs, launches, screenshots
```
Development builds read `PANDA_SERVER`, `PANDA_DEVICE_SECRET`, `PANDA_TOKEN` and `PANDA_KEYS`
("wait:3000 down select menu") from the launch environment (`SIMCTL_CHILD_*`), to skip typing
with the remote and to script presses; release builds ignore them.

On an Apple TV:
1. Sign in to Xcode with your Apple ID (Settings > Accounts) and create an **Apple Development**
   certificate (Manage Certificates > +). Put the team ID in
   `clients/appletv/team.local` (one line; git-ignored, so it stays out of the repo) or
   `$PANDA_TEAM_ID` (the `OU=` of
   `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`).
2. Pair the Apple TV (same network as the Mac): on the Apple TV, Settings > Remotes and Devices >
   **Remote App and Devices**; on the Mac, Xcode > Window > **Devices and Simulators**, select the
   Apple TV and enter the code it shows.
   (Xcode 27 moved this window into **DeviceHub**: Xcode > Open Developer Tool > DeviceHub.)
3. `./scripts/run-device.sh` (or `./scripts/run-device.sh <device id or name>`): builds for that
   Apple TV, installs and launches. The first build registers the Apple TV with your team and
   creates the provisioning profile. `CONFIG=Release` for a release build.

A free Apple ID (Personal Team) works, but the app must be reinstalled every 7 days; a paid
developer account avoids that. Always build for a device through `run-device.sh`: `ns run` can't
register a new Apple TV, and NativeScript 9.2 needs the team passed as `--teamId`.

App icon and Top Shelf: layered icon (parallax on focus) and static Top Shelf banners in
`App_Resources/tvOS/Assets.xcassets`, generated from the panda avatar and the app's palette by
`node scripts/make-brand-assets.cjs` (re-run after changing the artwork; outputs are committed).
Menu on Home (with the top bar focused) returns to the Apple TV home screen, as tvOS expects.

tvOS specifics handled in the host: the UIScene lifecycle tvOS 27 requires, local-network-only
plain http (App Transport Security), SVG images pre-rendered to PNG at build time (no SVG
rasterizer on tvOS), and a full-screen canvas.

## Performance tiers

Older and smaller TVs get a lighter "low" tier automatically (`clients/tv/devices/tier.ts`):
LG webOS 5 and older, Samsung Tizen before 6.0 (2020 models and earlier), entry Fire TV sticks,
and anything reporting 2 GB of RAM or less. Low draws 720p (the TV scales it up), keeps about a
third of the decoded artwork in memory, turns animations off, preloads less, and stops the home
hero from changing by itself. Change it per TV in Edit profile > **Performance (this TV)**
(Auto / High / Low; the app restarts), or test with `?tier=low` in the dev URL.

## Troubleshooting

- **"Can't reach a Panda server"** on the Connect screen: check the IP (`ipconfig getifaddr en0`
  on the Mac running Panda), that it's on the same network, and the macOS firewall.
- **Wrong server**: Back out to sign-in and re-run Connect, or clear the app's data on the TV.
- **Too many sign-in attempts**: the server limits how many codes one network can request; the
  TV waits and retries by itself.
