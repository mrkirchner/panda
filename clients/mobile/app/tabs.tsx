// The signed-in app: a tab bar (Home, Movies, Shows, Search), each tab with its own Frame and
// history.
import { Frame, Page, TabView, TabViewItem, type SelectedIndexChangedEventData } from "@nativescript/core";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { t } from "@tv/i18n";
import { makePage, setCurrentFrame, showRoot, type ScreenOptions } from "./nav";

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
  const frames: Frame[] = [];
  const items = tabs.map(tab => {
    const frame = new Frame();
    frames.push(frame);
    frame.navigate({ create: () => makePage(tab.screen, tab.opts, () => frame), animated: false });
    const item = new TabViewItem();
    item.title = t(tab.title);
    item.iconSource = `sys://${tab.icon}`;
    item.view = frame;
    return item;
  });
  view.items = items;
  setCurrentFrame(frames[0]);
  view.on("selectedIndexChanged", (e: SelectedIndexChangedEventData) => {
    setCurrentFrame(frames[e.newIndex]);
    onTabShown.get(tabs[e.newIndex]?.title ?? "")?.();
  });
  selectIndex = i => (view.selectedIndex = i);
  const page = new Page();
  page.actionBarHidden = true;
  page.content = view;
  showRoot(page);
}
