// The signed-in app: a tab bar (Home, Movies, Shows, Search), each tab with its own Frame and
// history.
import { Frame, Page, TabView, TabViewItem, type SelectedIndexChangedEventData } from "@nativescript/core";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { t } from "@tv/i18n";
import { symbol } from "./symbols";
import { makePage, releaseFrame, setBeforeRootReset, setCurrentFrame, showRoot, type ScreenOptions } from "./nav";

interface Tab {
  title: string;
  /** SF Symbol. */
  icon: string;
  screen: () => JSX.Element;
  opts: ScreenOptions;
}

let selectIndex: (i: number) => void = () => {};
/** Called when a tab is chosen (Search focuses its bar), by tab title. */
export const onTabShown = new Map<string, () => void>();
/** Switch to tab `i` (0: Home). */
export const selectTab = (i: number) => selectIndex(i);

export function showTabs(tabs: Tab[]): void {
  const view = new TabView();
  view.className = "tabs";
  // Android puts tabs at the top by default; Panda's are at the bottom on both.
  if (__ANDROID__) view.androidTabsPosition = "bottom";
  const frames: Frame[] = [];
  /** A tab is built the first time it's chosen (not all five at launch, each with its requests). */
  const built = new Set<number>();
  const build = (i: number) => {
    if (built.has(i)) return;
    built.add(i);
    const frame = frames[i];
    frame.navigate({ create: () => makePage(tabs[i].screen, tabs[i].opts, () => frame), animated: false });
  };
  const items = tabs.map(tab => {
    const frame = new Frame();
    frames.push(frame);
    const item = new TabViewItem();
    item.title = t(tab.title);
    item.textTransform = "none";
    item.iconSource = symbol(tab.icon);
    item.view = frame;
    return item;
  });
  view.items = items;
  build(0);
  setCurrentFrame(frames[0]);
  view.on("selectedIndexChanged", (e: SelectedIndexChangedEventData) => {
    build(e.newIndex);
    setCurrentFrame(frames[e.newIndex]);
    onTabShown.get(tabs[e.newIndex]?.title ?? "")?.();
  });
  selectIndex = i => (view.selectedIndex = i);
  const page = new Page();
  page.actionBarHidden = true;
  page.content = view;
  showRoot(page);
  // Signed out or another profile: every tab's screens go with the tab bar.
  setBeforeRootReset(() => {
    for (const f of frames) releaseFrame(f);
    onTabShown.clear();
  });
}
