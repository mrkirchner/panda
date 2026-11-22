import { activeElement, type ElementNode } from "@solidtv/solid";
import { useNavigate as useRouterNavigate, type NavigateOptions, type Navigator } from "@solidjs/router";
import { markReturn } from "./focusMemory";

/**
 * The top bar's focus handoff. Each main page renders a `TopBar`, which registers itself here;
 * Back (app root) and Up from a page's top focus it, and its Down goes back to the page.
 */
let bar: ElementNode | undefined;

export const registerTopBar = (el: ElementNode) => (bar = el);

export function focusTopBar() {
  if (!bar) return false;
  bar.setFocus();
  return true;
}

/** Is focus somewhere in the top bar? */
export function topBarHasFocus() {
  let el: ElementNode | undefined = activeElement() as ElementNode | undefined;
  while (el) {
    if (el === bar) return true;
    el = el.parent as ElementNode | undefined;
  }
  return false;
}

/**
 * The trail of pages, one per history entry (by the router's `_depth` stamp, so Back,
 * replaced entries and the browser's own buttons all keep it right). App notes each page.
 */
const trail: string[] = [];
const historyDepth = (): number => (window.history.state as { _depth?: number } | null)?._depth ?? 0;
const pageKey = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};
export function notePage(path: string) {
  // After the router has stamped the new entry's depth (it does so just after the page changes).
  setTimeout(() => {
    const d = historyDepth();
    trail.length = d + 1;
    trail[d] = pageKey(path);
  }, 0);
}

/** Pages that link to each other (title -> cast -> title...): opening one already in the trail
 * goes back to it, so the trail never loops and Back gets you out quickly. */
const LINKED_PAGE = /^\/(title|series|person|discover|genre)\//;

/**
 * `useNavigate`, except that opening a title, show, person, preview or genre page you came
 * through goes back to it (where you were on it) instead of stacking a copy.
 */
export function useNavigate(): Navigator {
  const navigate = useRouterNavigate();
  return ((to: string | number, options?: Partial<NavigateOptions>) => {
    if (typeof to === "string" && !options?.replace && LINKED_PAGE.test(to)) {
      const d = historyDepth();
      const earlier = trail.lastIndexOf(pageKey(to), d - 1);
      if (earlier >= 0) {
        markReturn();
        window.history.go(earlier - d);
        return;
      }
    }
    if (typeof to === "number") navigate(to);
    else navigate(to, options);
  }) as Navigator;
}
