// A page's data and the app-wide refresh, as in the phone app (../mobile/app/data.ts): a page
// loads what it shows once; pages showing watch progress, My List or requests are "live" and ask
// again on `refreshAll()` (the player closed, a title marked watched, a request made).
import { createSignal, onCleanup, untrack } from "solid-js";

const live = new Set<() => void>();

/** Something changed what pages show: every live page asks again. */
export function refreshAll() {
  for (const reload of live) reload();
  for (const hook of refreshHooks) hook();
}

/** App-wide stores (requests, My List, offline libraries) that also refresh on `refreshAll()`. */
export const refreshHooks = new Set<() => void>();

/** A page's data: `value` is undefined until it arrives, `error` if it failed. The request starts
 * untracked (it reads signals such as the server address once). */
export function load<T>(fetcher: () => Promise<T>, opts: { live?: boolean } = {}) {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const run = () =>
    untrack(fetcher).then(
      v => {
        setValue(() => v);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  // Started after this component is built (Solid 2 allows no writes while it is).
  queueMicrotask(() => void run());
  const reload = () => void run();
  if (opts.live) {
    live.add(reload);
    onCleanup(() => live.delete(reload));
  }
  return { value, error, reload };
}

/** "2h 14m", "48m". */
export function runtime(secs: number | null | undefined): string {
  if (!secs) return "";
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** "2009 · 1h 37m · Science Fiction", leaving out what's unknown. */
export function facts(parts: (string | number | null | undefined)[]): string {
  return parts.filter(p => p !== null && p !== undefined && p !== "").join("  ·  ");
}

/** The first genres of a comma-separated list. */
export const genres = (g: string | null | undefined, n = 2) =>
  (g ?? "")
    .split(/,\s*/)
    .filter(Boolean)
    .slice(0, n)
    .join(", ");

/** "48.2 GB". */
export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** An error as words. */
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
