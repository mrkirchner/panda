// What the TV client's shared code (../tv/src: api, i18n) expects of a browser, for NativeScript:
// `localStorage` (kept in ApplicationSettings: NSUserDefaults on iOS, SharedPreferences on
// Android) and `navigator.language`.
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
  const preferred = __IOS__
    ? (NSLocale.preferredLanguages.firstObject as string | undefined)
    : java.util.Locale.getDefault().toLanguageTag();
  nav.language = preferred ?? "en";
}

// Language names ("Korean", "coreano"): the TV code asks Intl.DisplayNames, which this JavaScript
// engine is built without (it may have no Intl at all); the platform knows them all, in every
// language (iOS: NSLocale; Android: java.util.Locale).
const intl = (g.Intl ??= {}) as { DisplayNames?: unknown };
if (!intl.DisplayNames) {
  intl.DisplayNames = __IOS__
    ? class {
        private readonly locale: NSLocale;
        constructor(locales: string[] | string | undefined) {
          const id = (Array.isArray(locales) ? locales[0] : locales) ?? "en";
          this.locale = NSLocale.localeWithLocaleIdentifier(id);
        }
        of(code: string): string | undefined {
          return this.locale.localizedStringForLanguageCode(code) ?? undefined;
        }
      }
    : class {
        private readonly locale: java.util.Locale;
        constructor(locales: string[] | string | undefined) {
          const id = (Array.isArray(locales) ? locales[0] : locales) ?? "en";
          this.locale = java.util.Locale.forLanguageTag(id);
        }
        of(code: string): string | undefined {
          const name = java.util.Locale.forLanguageTag(code).getDisplayLanguage(this.locale);
          // An unknown code comes back as itself.
          return name && name !== code ? name : undefined;
        }
      };
}
