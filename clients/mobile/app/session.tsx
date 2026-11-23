// Where to go after launch, sign-in, or a profile switch.
import { landingPath, resetSession } from "@tv/api/client";
import { getDeviceSecret, setUnauthorizedHandler } from "@tv/api/session";
import { t } from "@tv/i18n";
import { open } from "./nav";
import { Home } from "./screens/Home";
import { Profiles } from "./screens/Profiles";
import { SignIn } from "./screens/SignIn";

export function goHome() {
  open(() => <Home />, {
    title: "Panda",
    clear: true,
    actions: getDeviceSecret() ? [{ text: t("Profiles"), tap: goProfiles }] : [],
  });
}

export function goProfiles() {
  open(() => <Profiles />, { title: t("Who's watching?"), clear: true });
}

export function goSignIn() {
  open(() => <SignIn />, { clear: true });
}

/** Signed in (or switched): pick a profile when the account has several, else Home. */
export async function afterSignIn() {
  resetSession();
  if ((await landingPath()) === "/profiles") goProfiles();
  else goHome();
}

/** A revoked session goes to the profile picker; a revoked device to sign-in (as on the TV). */
setUnauthorizedHandler(() => (getDeviceSecret() ? goProfiles() : goSignIn()));
