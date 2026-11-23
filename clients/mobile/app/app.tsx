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
import { devLaunch } from "./devLaunch";

// Bonjour: the Panda servers on this network (the Apple TV host's, same iOS APIs).
installDiscovery();

/** Launch: the server, then sign-in, then a profile; each step only when it's missing. */
function start() {
  if (!getServer()) return open(() => <Connect />, { clear: true });
  if (!getToken()) return getDeviceSecret() ? goProfiles() : goSignIn();
  ensureSession().then(() => {
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
