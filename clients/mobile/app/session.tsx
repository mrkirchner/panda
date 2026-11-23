// Where to go after launch, sign-in, or a profile switch.
import { api, landingPath, resetSession } from "@tv/api/client";
import { getDeviceSecret, setUnauthorizedHandler } from "@tv/api/session";
import { t } from "@tv/i18n";
import { open } from "./nav";
import { Home } from "./screens/Home";
import { browseScreen } from "./screens/Browse";
import { Search } from "./screens/Search";
import { showTabs } from "./tabs";
import { Profiles } from "./screens/Profiles";
import { SignIn } from "./screens/SignIn";

/** Signed in: the tab bar, starting on Home. */
export function goHome() {
  const profiles = getDeviceSecret() ? [{ text: t("Profiles"), tap: goProfiles }] : [];
  showTabs([
    { title: "Home", icon: "house.fill", screen: () => <Home />, opts: { title: "Panda", actions: profiles } },
    {
      title: "Movies",
      icon: "film",
      screen: () => browseScreen(() => api.browsePage("movies"), "movies"),
      opts: { title: t("Movies") },
    },
    {
      title: "Shows",
      icon: "tv",
      screen: () => browseScreen(() => api.browsePage("shows"), "shows"),
      opts: { title: t("Shows") },
    },
    { title: "Search", icon: "magnifyingglass", screen: () => <Search />, opts: { title: t("Search") } },
  ]);
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
