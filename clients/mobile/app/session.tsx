// Where to go after launch, sign-in, or a profile switch.
import { api, landingPath, resetSession } from "@tv/api/client";
import { currentUser, getDeviceSecret, setDeviceSecret, setToken, setUnauthorizedHandler } from "@tv/api/session";
import { Dialogs } from "@nativescript/core";
import { t } from "@tv/i18n";
import { back, open } from "./nav";
import { MyList } from "./screens/MyList";
import { aboutScreen } from "./screens/About";
import { Avatar } from "./avatar";
import { editProfileScreen } from "./screens/EditProfile";
import { Home } from "./screens/Home";
import { browseScreen } from "./screens/Browse";
import { Search } from "./screens/Search";
import { openAll } from "./screens/links";
import { showTabs } from "./tabs";
import { Profiles } from "./screens/Profiles";
import { SignIn } from "./screens/SignIn";

/** Home's profile button: edit this profile, switch, or sign this phone out. */
async function profileMenu() {
  const edit = t("Edit profile");
  const change = t("Switch profile");
  const out = t("Sign out of this phone");
  const about = t("About Panda");
  const pick = await Dialogs.action({
    title: currentUser()?.name ?? "",
    cancelButtonText: t("Cancel"),
    actions: getDeviceSecret() ? [edit, change, about, out] : [edit, about, out],
  });
  if (pick === edit) open(() => editProfileScreen(back), { title: t("Edit profile") });
  else if (pick === change) goProfiles();
  else if (pick === about) open(() => aboutScreen(), { title: t("About Panda") });
  else if (pick === out) {
    setToken(null);
    setDeviceSecret(null);
    goSignIn();
  }
}

/** Signed in: the tab bar, starting on Home. */
export function goHome() {
  // The profile's own picture (as the TV's top bar shows it), which opens the profile menu.
  const profiles = [
    {
      text: t("Profile"),
      view: () => <Avatar name={currentUser()?.name ?? "?"} picture={currentUser()?.avatar ?? null} size={40} />,
      tap: () => void profileMenu(),
    },
  ];
  showTabs([
    { title: "Home", icon: "house.fill", screen: () => <Home />, opts: { title: "Panda", actions: profiles } },
    {
      title: "Movies",
      icon: "film",
      screen: () => browseScreen(() => api.browsePage("movies"), { of: "kind", kind: "movies" }),
      opts: { title: t("Movies"), actions: [{ text: t("All"), icon: "square.grid.3x3", tap: () => openAll("movies") }] },
    },
    {
      title: "Shows",
      icon: "tv",
      screen: () => browseScreen(() => api.browsePage("shows"), { of: "kind", kind: "shows" }),
      opts: { title: t("Shows"), actions: [{ text: t("All"), icon: "square.grid.3x3", tap: () => openAll("shows") }] },
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
