// The frame around every page: the top bar (all sizes) and the bottom tabs (phones and small
// tablets), as the TV's TopBar: Home, a tab per library by its name, My List; Search; the profile
// (Who's watching, Edit profile, About, sign out). Pages that are art-first run under the bar,
// which turns solid once the page scrolls.
import { useLocation } from "@solidjs/router";
import { currentUser } from "@tv/api/session";
import { t } from "@tv/i18n";
import type { JSX } from "@solidjs/web";
import { For, createMemo, createSignal, onSettled } from "solid-js";
import { libraries } from "../features";
import { load } from "../data";
import { appPath, href, go, paths } from "../nav";
import { signOutBrowser } from "../session";
import { Avatar } from "./Avatar";
import { Icon, type IconName } from "./icons";
import { OfflineBanner } from "./Offline";
import { pick } from "./ui";

interface Tab {
  label: string;
  path: string;
}

export function Shell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const libs = load(() => libraries());
  const [scrolled, setScrolled] = createSignal(false);
  onSettled(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  });

  /** The TV's tabs: Home, a tab per library by its name, My List. A kind with several libraries
   * gets one tab (Movies/Shows), whose page lists them, so the top bar stays short. */
  const topTabs = createMemo<Tab[]>(() => {
    const all = libs.value() ?? [];
    const tabs: Tab[] = [{ label: t("Home"), path: "/" }];
    for (const kind of ["movies", "shows"] as const) {
      const of = all.filter((l) => l.kind === kind);
      if (of.length === 1) tabs.push({ label: of[0].name, path: paths.library(of[0].id) });
      else if (of.length > 1)
        tabs.push({ label: kind === "movies" ? t("Movies") : t("Shows"), path: paths[kind] });
    }
    tabs.push({ label: t("My List"), path: paths.myList });
    return tabs;
  });
  const active = (path: string) => {
    const p = appPath(location.pathname);
    return path === "/" ? p === "/" : p === path || p.startsWith(`${path}/`);
  };
  const bottomTabs: { label: string; path: string; icon: IconName }[] = [
    { label: "Home", path: "/", icon: "home" },
    { label: "Movies", path: paths.movies, icon: "film" },
    { label: "Shows", path: paths.shows, icon: "tv" },
    { label: "Search", path: "/search", icon: "search" },
    { label: "My List", path: paths.myList, icon: "bookmark" },
  ];

  const profileMenu = async (e: MouseEvent) => {
    const options = [t("Switch profile"), t("Edit profile"), t("About"), t("Sign out of this browser")];
    const i = await pick(
      currentUser()?.name,
      options.map((label) => ({ label })),
      e.currentTarget as Element,
    );
    if (i === 0) go(paths.profiles);
    else if (i === 1) go(paths.editProfile);
    else if (i === 2) go("/about");
    else if (i === 3) signOutBrowser();
  };

  return (
    <div class="app">
      <header class={["topbar", { solid: scrolled() }]}>
        <a class="brand" href={href("/")} aria-label="Panda">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>Panda</span>
        </a>
        <nav class="top-tabs" aria-label={t("Main")}>
          <For each={topTabs()}>
            {(tab) => (
              <a class="top-tab" href={href(tab.path)} data-active={active(tab.path) ? "" : undefined}>
                {tab.label}
              </a>
            )}
          </For>
        </nav>
        <div class="topbar-end">
          <a class="icon-btn top-search" href={href("/search")} aria-label={t("Search")}>
            <Icon name="search" />
          </a>
          <button class="profile-btn" aria-label={t("Profile")} onClick={(e) => void profileMenu(e)}>
            <Avatar name={currentUser()?.name ?? "?"} picture={currentUser()?.avatar} size={34} />
          </button>
        </div>
      </header>
      <OfflineBanner />
      <main class="page">{props.children}</main>
      <nav class="bottom-tabs" aria-label={t("Main")}>
        <For each={bottomTabs}>
          {(tab) => (
            <a class="bottom-tab" href={href(tab.path)} data-active={active(tab.path) ? "" : undefined}>
              <Icon name={tab.icon} size={24} />
              <span>{t(tab.label)}</span>
            </a>
          )}
        </For>
      </nav>
    </div>
  );
}

/** A plain heading area for pages without art at the top (Search, My List, All...). */
export function PageTop(props: { children?: JSX.Element }) {
  return <div class="page-top">{props.children}</div>;
}
