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

// Language names ("Korean", "coreano"): the TV code asks Intl.DisplayNames, which this JavaScript
// engine is built without (it may have no Intl at all); iOS knows them all, in every language.
const intl = (g.Intl ??= {}) as { DisplayNames?: unknown };
if (!intl.DisplayNames) {
  intl.DisplayNames = class {
    private readonly locale: NSLocale;
    constructor(locales: string[] | string | undefined) {
      const id = (Array.isArray(locales) ? locales[0] : locales) ?? "en";
      this.locale = NSLocale.localeWithLocaleIdentifier(id);
    }
    of(code: string): string | undefined {
      return this.locale.localizedStringForLanguageCode(code) ?? undefined;
    }
  };
}
