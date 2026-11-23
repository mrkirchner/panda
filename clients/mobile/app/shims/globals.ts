// What the TV client's shared code (../tv/src: api, i18n) expects of a browser, for NativeScript:
// `localStorage` (kept in ApplicationSettings, i.e. NSUserDefaults) and `navigator.language`.
// Imported first by app.tsx, before any of that code runs.
import { ApplicationSettings } from "@nativescript/core";

const g = globalThis as unknown as Record<string, unknown>;

if (!g.localStorage) {
  g.localStorage = {
    getItem: (key: string) => (ApplicationSettings.hasKey(key) ? ApplicationSettings.getString(key) : null),
    setItem: (key: string, value: string) => ApplicationSettings.setString(key, String(value)),
    removeItem: (key: string) => ApplicationSettings.remove(key),
  };
}

const nav = (g.navigator ??= {}) as { language?: string };
if (!nav.language) {
  const preferred = NSLocale.preferredLanguages.firstObject as string | undefined;
  nav.language = preferred ?? "en";
}
