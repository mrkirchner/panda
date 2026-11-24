// Panda on iPhone and Android phones. Shims first (the TV client's shared code reads browser globals at import),
// then the app: one Frame whose pages are the screens (nav.ts).
import "./shims/globals";
import { AndroidApplication, Application, Frame } from "@nativescript/core";
import { AuthError, ensureSession, landingPath } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret, getToken } from "@tv/api/session";
import { afterLoaded, open, setRootFrame } from "./nav";
import { Connect } from "./screens/Connect";
import { goHome, goProfiles, goSignIn } from "./session";
import { devLaunch, devOpens, devPrepare } from "./devLaunch";
import { openSeries, openTitle } from "./screens/links";
import { platform } from "./platform";
import { checkArrivals } from "./arrivals";

// The Panda servers on this network: Bonjour on iPhone, NSD on Android (discovery.*.ts).

if (__IOS__) {
  // Preview clips mix with whatever else is playing (music, a podcast) instead of stopping it;
  // the player takes the sound over while it's open (player.ios.ts). Android: clips don't ask
  // for audio focus at all (clip.android.ts).
  AVAudioSession.sharedInstance().setCategoryModeOptionsError(
    AVAudioSessionCategoryAmbient,
    AVAudioSessionModeDefault,
    0 as AVAudioSessionCategoryOptions,
  );

  // Artwork is immutable on the server (cached for weeks): keep plenty of it (iOS's default
  // cache, ~10 MB, would download and decode posters again on every scroll and visit). Android's
  // image loader keeps its own memory and disk cache.
  NSURLCache.sharedURLCache = NSURLCache.alloc().initWithMemoryCapacityDiskCapacityDiskPath(
    50 * 1024 * 1024,
    300 * 1024 * 1024,
    "panda-images",
  );
}

/** Launch: the server, then sign-in, then a profile; each step only when it's missing. */
// "Dune is ready to watch": the OS runs the check in the background (Android's WorkManager,
// iOS's background refresh). Here at the top, so a background start (no screens) has it too.
const notes = platform.notifications;
if (notes?.watch) notes.watch(() => checkArrivals(notes));

/** A notification's page ("/title/m927", "/series/Name"), opened over Home. */
function openPath(path: string | null | undefined): void {
  if (!path) return;
  const [, kind, ...rest] = path.split("/");
  const id = rest.join("/");
  if (kind === "title") openTitle(id);
  else if (kind === "series") openSeries(id);
}

/** Android: the page a tapped notification asks for (once). */
function launchPath(): string | null {
  if (!__ANDROID__) return null;
  const intent = (Application.android.startActivity as android.app.Activity | undefined)?.getIntent();
  const path = intent?.getStringExtra("panda.open") ?? null;
  intent?.removeExtra("panda.open");
  return path;
}
if (__ANDROID__) {
  // Tapped while the app was already running.
  Application.android.on(AndroidApplication.activityNewIntentEvent, (e: { intent: android.content.Intent }) => {
    const path = e.intent.getStringExtra("panda.open");
    e.intent.removeExtra("panda.open");
    // The process may be up with no screens yet (a background check started it): after the
    // first page, or it would end up under Home.
    if (path && getToken()) afterLoaded(() => openPath(path));
  });
}

function start() {
  if (!getServer()) return open(() => <Connect />, { clear: true });
  if (!getToken()) return getDeviceSecret() ? goProfiles() : goSignIn();
  ensureSession().then(async () => {
    if (__DEV__) devPrepare();
    // An account with several profiles picks one first, as the TV does at launch.
    if ((await landingPath()) === "/profiles" && !(__DEV__ && devOpens())) return goProfiles();
    goHome();
    const opening = launchPath();
    if (opening) afterLoaded(() => openPath(opening));
    if (__DEV__) devLaunch();
  }, (e: unknown) => {
    // Signed out meanwhile: the unauthorized handler has already moved on.
    if (!(e instanceof AuthError)) goHome();
  });
}

Application.run({
  create: () => {
    const frame = new Frame();
    setRootFrame(frame);
    frame.on("loaded", start);
    return frame;
  },
});
