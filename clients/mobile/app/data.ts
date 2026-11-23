import { lang } from "@tv/i18n";
import { createSignal, onCleanup, untrack } from "solid-js";

/** Screens' loads that show watch progress, My List or requests: asked again on `refreshAll()`. */
const live = new Set<() => void>();

/** Something changed what screens show (the player closed, My List, a request, Watched): every
 * live screen asks again. Tab pages stay alive, so without this they'd go stale. */
export function refreshAll() {
  for (const reload of live) reload();
  for (const hook of refreshHooks) hook();
}

/** App-wide stores (requests, offline libraries) that also refresh on `refreshAll()`. */
export const refreshHooks = new Set<() => void>();

/** A screen's data: loads once, `value` until then undefined, `error` if it failed. The request
 * starts untracked (it reads the server address, a signal, once). `live`: asked again on
 * `refreshAll()` while the screen exists. */
export function load<T>(fetcher: () => Promise<T>, opts: { live?: boolean } = {}) {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const run = () =>
    untrack(fetcher).then(
      v => setValue(() => v),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  void run();
  /** Ask again (after a change): the old answer stays shown meanwhile. */
  const reload = () => run();
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

/** "Year · 2h 14m · ★ 7.8", leaving out what's unknown. */
export function facts(parts: (string | number | null | undefined)[]): string {
  return parts.filter(p => p !== null && p !== undefined && p !== "").join("  ·  ");
}

/** "March 3, 2024" from "2024-03-03" (Spanish: "3 de marzo de 2024"). Formatted here: the
 * phone's JavaScript has no locale data, so toLocaleDateString ignores its options. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export function longDate(iso: string | null | undefined): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso ?? null;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (month < 0 || month > 11) return iso ?? null;
  return lang() === "es" ? `${day} de ${MESES[month]} de ${year}` : `${MONTHS[month]} ${day}, ${year}`;
}

/** "48.2 GB". */
export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
