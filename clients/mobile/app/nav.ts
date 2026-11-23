// Navigation: the sign-in screens are pages on the app's root Frame; once signed in, the root
// shows the tab bar (tabs.ts), and each tab has its own Frame so it keeps its own history.
// `open()` pushes onto the frame in use: the selected tab's, else the root's. Pages are native,
// so iOS gives each its navigation bar and the swipe back. A page's Solid tree lives as long as
// the page: it's disposed once the page is gone (popped by Back, or dropped by a cleared history).
import { ActionItem, Frame, type GridLayout, type NavigatedData, Page } from "@nativescript/core";
import { render } from "@nativescript-community/solid-js";
import { setSheetOpen } from "./clip";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";

let root: Frame | null = null;
let current: Frame | null = null;
export const setRootFrame = (f: Frame) => (root = current = f);
/** The frame `open()` pushes onto (the selected tab's). */
export const setCurrentFrame = (f: Frame) => (current = f);
export const rootFrame = () => root;
export const currentFrame = () => current;

export interface ScreenOptions {
  /** Navigation bar title (none: no bar, e.g. sign-in screens). */
  title?: string;
  /** Start a new history (after sign-in or switching profile): Back can't return here. */
  clear?: boolean;
  /** Buttons on the right of the navigation bar. */
  actions?: { text: string; icon?: string; view?: () => JSX.Element; tap: () => void }[];
}

/** A native page showing `screen`, disposed when it's gone from `frame`. */
export function makePage(screen: () => JSX.Element, opts: ScreenOptions, frame: () => Frame | null): Page {
  const page = document.createElement("page") as unknown as Page;
  page.actionBarHidden = opts.title === undefined;
  if (opts.title !== undefined) page.actionBar.title = opts.title;
  page.className = "screen";
  for (const a of opts.actions ?? []) {
    const item = new ActionItem();
    item.text = a.text;
    if (a.icon) item.icon = `sys://${a.icon}`;
    if (a.view) {
      // A view of its own (the profile's avatar): taps go to it, not to the item.
      const host = document.createElement("gridlayout") as unknown as GridLayout;
      render(a.view, host as unknown as Element);
      host.on("tap", a.tap);
      item.actionView = host;
    }
    item.ios.position = "right";
    item.on("tap", a.tap);
    page.actionBar.actionItems.addItem(item);
  }
  const dispose = render(screen, page as unknown as Element);
  // A button with a view of its own (the avatar) is drawn without iOS 26's glass circle behind
  // it, so the picture is the whole button.
  if (opts.actions?.some(a => a.view)) {
    page.on("navigatedTo", () => {
      const items = (page.ios as UIViewController | undefined)?.navigationItem.rightBarButtonItems;
      for (let i = 0; i < (items?.count ?? 0); i++) {
        const item = items!.objectAtIndex(i) as UIBarButtonItem & { hidesSharedBackground?: boolean };
        if (item.customView && "hidesSharedBackground" in item) item.hidesSharedBackground = true;
      }
    });
  }
  page.on("navigatedFrom", (e: NavigatedData) => {
    const f = frame();
    if (e.isBackNavigation || !f?.backStack.some(entry => entry.resolvedPage === page)) dispose();
  });
  return page;
}

/** Push `screen` onto the frame in use (or, with `clear`, start the app's root over with it). */
export function open(screen: () => JSX.Element, opts: ScreenOptions = {}): void {
  const frame = opts.clear ? root : current;
  if (!frame) throw new Error("no frame yet");
  if (opts.clear) current = root;
  const page = makePage(screen, opts, () => frame);
  frame.navigate({ create: () => page, clearHistory: opts.clear ?? false, animated: !opts.clear });
}

/** Show `page` as the root's only page (the tab bar). */
export function showRoot(page: Page): void {
  root?.navigate({ create: () => page, clearHistory: true, animated: false });
}

export const back = () => current?.goBack();

let closeSheet: (() => void) | null = null;

/**
 * `screen` in a sheet over the current page (half the screen, pulled up for more): the phone's
 * expanded tile. `closeSheet()` dismisses it (before playing, or opening the full page).
 */
export function openSheet(screen: () => JSX.Element): void {
  const page = (current ?? root)?.currentPage;
  if (!page) return;
  const host = document.createElement("gridlayout") as unknown as import("@nativescript/core").GridLayout;
  host.className = "sheet";
  const dispose = render(screen, host as unknown as Element);
  host.on("shownModally", () => {
    const vc = (host as unknown as { viewController?: UIViewController }).viewController;
    const sheet = vc?.sheetPresentationController;
    if (sheet) {
      sheet.detents = NSArray.arrayWithArray([
        UISheetPresentationControllerDetent.mediumDetent(),
        UISheetPresentationControllerDetent.largeDetent(),
      ]) as NSArray<UISheetPresentationControllerDetent>;
      sheet.prefersGrabberVisible = true;
      sheet.preferredCornerRadius = 20;
    }
  });
  closeSheet = () => host.closeModal();
  setSheetOpen(true);
  page.showModal(host, {
    fullscreen: false,
    animated: true,
    closeCallback: () => {
      closeSheet = null;
      setSheetOpen(false);
      dispose();
    },
    ios: { presentationStyle: UIModalPresentationStyle.PageSheet },
  });
}

/** Close the sheet, then `then` (navigation waits for the sheet to be gone). */
export function leaveSheet(then: () => void) {
  if (!closeSheet) return then();
  closeSheet();
  setTimeout(then, 350);
}
