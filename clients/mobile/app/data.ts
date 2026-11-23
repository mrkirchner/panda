import { createSignal } from "solid-js";

/** A screen's data: loads once, `value` until then undefined, `error` if it failed. */
export function load<T>(fetcher: () => Promise<T>) {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  fetcher().then(
    v => setValue(() => v),
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  );
  return { value, error };
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
