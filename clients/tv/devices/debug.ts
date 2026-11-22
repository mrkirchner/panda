import { createSignal } from "solid-js";

/**
 * Developer tools for testing devices, set per TV on the admin-only Debug page (src/pages/Debug.tsx)
 * and kept on the device:
 *
 * - FPS meter: on by default in development builds (the browser dev server and Apple TV Debug
 *   builds from clients/appletv/scripts/run-device.sh) and builds made with `VITE_SHOW_FPS=1`,
 *   off in release packages; `?fps=1` turns it on for one run. While it's off the renderer
 *   doesn't sample frame times at all.
 * - Request tracing to the console: the same default.
 *
 * Performance tier and resolution overrides live with their own modules (tier.ts, resolution.ts).
 */
const FPS_KEY = "panda.debug.fps";
const TRACE_KEY = "panda.debug.trace";

/** Builds made for development, where the tools are on unless turned off. */
export const devBuild: boolean = import.meta.env.DEV || import.meta.env.VITE_SHOW_FPS === "1";

function fromUrl(): boolean {
  try {
    return typeof location !== "undefined" && new URLSearchParams(location.search).get("fps") === "1";
  } catch {
    return false;
  }
}

function load(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function save(key: string, on: boolean | null) {
  try {
    if (on === null) localStorage.removeItem(key);
    else localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // No storage: it lasts until restart.
  }
}

const [fps, setFps] = createSignal<boolean>(fromUrl() || (load(FPS_KEY) ?? devBuild));
const [tracing, setTracingSignal] = createSignal<boolean>(load(TRACE_KEY) ?? devBuild);

/** The FPS meter shows (reactive: it can be switched while the app runs). */
export const showFps = fps;
export const traceOn = tracing;

/** Frame sampling for the renderer: only while the meter shows. */
export const fpsInterval = (): number => (fps() ? 1000 : 0);

/** Turn the meter on or off. `apply` tells the renderer (sampling costs a little per frame). */
export function setShowFps(on: boolean, apply?: (interval: number) => void) {
  setFps(on);
  save(FPS_KEY, on);
  apply?.(fpsInterval());
}

export function setTracing(on: boolean) {
  setTracingSignal(on);
  save(TRACE_KEY, on);
}

/** Back to this build's defaults. */
export function resetDebug(apply?: (interval: number) => void) {
  save(FPS_KEY, null);
  save(TRACE_KEY, null);
  setFps(devBuild);
  setTracingSignal(devBuild);
  apply?.(fpsInterval());
}

/** Request and navigation tracing to the console, while tracing is on. */
export const trace = (message: string): void => {
  if (tracing()) console.warn(`[trace ${Math.round(performance.now())}ms] ${message}`);
};
