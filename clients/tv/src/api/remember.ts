import { createSignal } from "solid-js";
import { getToken } from "./session";

/**
 * The last answer each screen got, per signed-in profile, kept in memory: going back to Home
 * or Search shows it at once (rows, and their artwork already in the texture cache) while a
 * fresh one loads, instead of rebuilding from nothing and popping rows in.
 */
const memory = new Map<string, unknown>();
const keyOf = (key: string) => `${getToken() ?? ""}|${key}`;

export interface Remembered<T> {
  (): T | undefined;
  /** A fresh answer is on its way (what's shown may be the remembered one). */
  readonly loading: boolean;
  readonly error: Error | undefined;
}

/**
 * Load `key` with `load`, starting from what was remembered for it. A fresh answer replaces
 * the shown one only when it differs, so rows (and focus) don't rebuild for nothing.
 */
export function remembered<T>(key: string, load: () => Promise<T>): Remembered<T> {
  const before = memory.get(keyOf(key)) as T | undefined;
  const [value, setValue] = createSignal<T | undefined>(before);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | undefined>();
  load()
    .then(
      v => {
        memory.set(keyOf(key), v);
        if (JSON.stringify(v) !== JSON.stringify(before)) setValue(() => v);
      },
      (e: unknown) => setError(e instanceof Error ? e : new Error(String(e))),
    )
    .finally(() => setLoading(false));
  return Object.assign(() => value(), {
    get loading() {
      return loading();
    },
    get error() {
      return error();
    },
  });
}

/** What was last remembered under `key` for this profile (to seed a store, say). */
export function recall<T>(key: string): T | undefined {
  return memory.get(keyOf(key)) as T | undefined;
}

/** Remember `value` under `key` for this profile. */
export function keep<T>(key: string, value: T) {
  memory.set(keyOf(key), value);
}
