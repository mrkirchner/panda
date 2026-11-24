// The app going out of sight (the Home button, another app, the TV or screen going to sleep) and
// coming back. Browsers, LG webOS and Samsung Tizen say so with `visibilitychange`; the native
// hosts (Apple TV: ../appletv/app/app.ts, Android TV: clients/android-tv MainActivity) call
// `globalThis.pandaSetHidden(hidden)` from their own lifecycle. Playback pauses and saves where it
// is, preview clips stop (Samsung's app review asks that nothing keeps playing out of sight).
type Listener = (hidden: boolean) => void;

const listeners = new Set<Listener>();
let hidden = false;

/** Whether the app is out of sight now. */
export const appHidden = () => hidden;

/** Follow the app hiding and showing; returns the unsubscribe. */
export function onAppVisibility(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Report a change (hosts without `visibilitychange` call this through `pandaSetHidden`). */
export function setAppHidden(now: boolean): void {
  if (now === hidden) return;
  hidden = now;
  for (const fn of [...listeners]) fn(now);
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => setAppHidden(document.visibilityState === "hidden"));
  // Leaving the page altogether (a closed browser tab, an app the TV ends).
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => setAppHidden(true));
}
(globalThis as unknown as { pandaSetHidden?: (hidden: boolean) => void }).pandaSetHidden = setAppHidden;
