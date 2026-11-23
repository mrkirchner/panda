// Screens are native pages pushed onto one Frame, so iOS gives each its navigation bar and the
// swipe back. A page's Solid tree lives as long as the page: it's disposed once the page is
// gone (popped by Back, or cleared).
import { ActionItem, Frame, type NavigatedData, type Page } from "@nativescript/core";
import { render } from "@nativescript-community/solid-js";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";

let frame: Frame | null = null;
export const setFrame = (f: Frame) => (frame = f);

export interface ScreenOptions {
  /** Navigation bar title (none: no bar, e.g. sign-in screens). */
  title?: string;
  /** Start a new history (after sign-in or switching profile): Back can't return here. */
  clear?: boolean;
  /** Buttons on the right of the navigation bar. */
  actions?: { text: string; tap: () => void }[];
}

export function open(screen: () => JSX.Element, opts: ScreenOptions = {}): void {
  if (!frame) throw new Error("no frame yet");
  const page = document.createElement("page") as unknown as Page;
  page.actionBarHidden = opts.title === undefined;
  if (opts.title !== undefined) page.actionBar.title = opts.title;
  page.className = "screen";
  for (const a of opts.actions ?? []) {
    const item = new ActionItem();
    item.text = a.text;
    item.ios.position = "right";
    item.on("tap", a.tap);
    page.actionBar.actionItems.addItem(item);
  }
  const dispose = render(screen, page as unknown as Element);
  page.on("navigatedFrom", (e: NavigatedData) => {
    // Popped (Back), or dropped by a cleared history: it never comes back.
    if (e.isBackNavigation || !frame?.backStack.some(entry => entry.resolvedPage === page)) dispose();
  });
  frame.navigate({ create: () => page, clearHistory: opts.clear ?? false, animated: !opts.clear });
}

export const back = () => frame?.goBack();
