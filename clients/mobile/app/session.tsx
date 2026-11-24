// Where to go after launch, sign-in, or a profile switch.
import { api, landingPath, resetSession } from "@tv/api/client";
import { currentUser, getDeviceSecret, setUnauthorizedHandler } from "@tv/api/session";
import { t } from "@tv/i18n";
import { afterLoaded, back, open } from "./nav";
import { MyList } from "./screens/MyList";
import { Avatar } from "./avatar";
import { editProfileScreen } from "./screens/EditProfile";
import { Home } from "./screens/Home";
import { browseScreen } from "./screens/Browse";
import { Search } from "./screens/Search";
import { openAll } from "./screens/links";
import { showTabs } from "./tabs";
import { Profiles } from "./screens/Profiles";
import { SignIn } from "./screens/SignIn";

/**
 * Home's profile button: Who's watching, as the TV's top bar opens it (a page; Back returns).
 * Editing a profile, About and signing out are there, as on the TV.
 */
function profileMenu() {
  if (!getDeviceSecret()) return void open(() => editProfileScreen(back), { title: t("Edit profile") });
  open(() => <Profiles />, { title: t("Who's watching?") });
}

/** Signed in: the tab bar, starting on Home. */
/** What the app's root shows: the tabs (signed in) or Who's watching. */
let rootShows: "tabs" | "profiles" | "other" = "other";

/**
 * The language changed: screens already built keep their words, so the root is built again in
 * the new language (as a profile switch does) and `reopen` puts back the screen that was open.
 */
export function relabel(reopen: () => void) {
  if (rootShows === "tabs") goHome();
  else if (rootShows === "profiles") goProfiles();
  else return;
  // After the new root's first page is up.
  afterLoaded(reopen);
}

export function goHome() {
  rootShows = "tabs";
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

/** Who's watching is the screen shown (a sign-out there must not open it again). */
let onProfiles = false;
export const setOnProfiles = (on: boolean) => (onProfiles = on);

export function goProfiles() {
  rootShows = "profiles";
  open(() => <Profiles />, { title: t("Who's watching?"), clear: true });
}

export function goSignIn() {
  rootShows = "other";
  open(() => <SignIn />, { clear: true });
}

/** Signed in (or switched): pick a profile when the account has several, else Home. */
export async function afterSignIn() {
  resetSession();
  if ((await landingPath()) === "/profiles") goProfiles();
  else goHome();
}

/** A revoked session goes to the profile picker; a revoked device to sign-in (as on the TV). */
setUnauthorizedHandler(() => {
  if (!getDeviceSecret()) goSignIn();
  else if (!onProfiles) goProfiles();
});
