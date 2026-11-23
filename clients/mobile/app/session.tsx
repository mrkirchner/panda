// Where to go after launch, sign-in, or a profile switch.
import { api, landingPath, resetSession } from "@tv/api/client";
import { currentUser, getDeviceSecret, setDeviceSecret, setToken, setUnauthorizedHandler } from "@tv/api/session";
import { Dialogs } from "@nativescript/core";
import { t } from "@tv/i18n";
import { back, open } from "./nav";
import { MyList } from "./screens/MyList";
import { editProfileScreen } from "./screens/EditProfile";
import { Home } from "./screens/Home";
import { browseScreen } from "./screens/Browse";
import { Search } from "./screens/Search";
import { showTabs } from "./tabs";
import { Profiles } from "./screens/Profiles";
import { SignIn } from "./screens/SignIn";

/** Home's profile button: edit this profile, switch, or sign this phone out. */
async function profileMenu() {
  const edit = t("Edit profile");
  const change = t("Switch profile");
  const out = t("Sign out of this phone");
  const pick = await Dialogs.action({
    title: currentUser()?.name ?? "",
    cancelButtonText: t("Cancel"),
    actions: getDeviceSecret() ? [edit, change, out] : [edit, out],
  });
  if (pick === edit) open(() => editProfileScreen(back), { title: t("Edit profile") });
  else if (pick === change) goProfiles();
  else if (pick === out) {
    setToken(null);
    setDeviceSecret(null);
    goSignIn();
  }
}

/** Signed in: the tab bar, starting on Home. */
export function goHome() {
  const profiles = [{ text: t("Profile"), icon: "person.crop.circle", tap: () => void profileMenu() }];
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
    { title: "My List", icon: "bookmark", screen: () => <MyList />, opts: { title: t("My List") } },
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
