// Panda on iPhone. Shims first (the TV client's shared code reads browser globals at import),
// then the app: one Frame whose pages are the screens (nav.ts).
import "./shims/globals";
import { Application, Frame } from "@nativescript/core";
import { installDiscovery } from "@appletv/discovery";
import { AuthError, ensureSession } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret, getToken } from "@tv/api/session";
import { open, setRootFrame } from "./nav";
import { Connect } from "./screens/Connect";
import { goHome, goProfiles, goSignIn } from "./session";
import { devLaunch, devPrepare } from "./devLaunch";

// Bonjour: the Panda servers on this network (the Apple TV host's, same iOS APIs).
installDiscovery();

// Preview clips mix with whatever else is playing (music, a podcast) instead of stopping it;
// the player takes the sound over while it's open (player.ts).
AVAudioSession.sharedInstance().setCategoryModeOptionsError(
  AVAudioSessionCategoryAmbient,
  AVAudioSessionModeDefault,
  0 as AVAudioSessionCategoryOptions,
);

// Artwork is immutable on the server (cached for weeks): keep plenty of it (iOS's default cache,
// ~10 MB, would download and decode posters again on every scroll and visit).
NSURLCache.sharedURLCache = NSURLCache.alloc().initWithMemoryCapacityDiskCapacityDiskPath(
  50 * 1024 * 1024,
  300 * 1024 * 1024,
  "panda-images",
);

/** Launch: the server, then sign-in, then a profile; each step only when it's missing. */
function start() {
  if (!getServer()) return open(() => <Connect />, { clear: true });
  if (!getToken()) return getDeviceSecret() ? goProfiles() : goSignIn();
  ensureSession().then(() => {
    if (__DEV__) devPrepare();
    goHome();
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
