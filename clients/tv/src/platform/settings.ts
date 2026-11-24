// Everything a Panda app keeps on the device, in one list. Every client (TV, Apple TV, phone,
// web) stores through here, so a new platform only has to provide `localStorage` (the phone app
// answers it with NativeScript's ApplicationSettings, app/shims/globals.ts) and gets every
// setting, and nobody has to hunt for key names. Storage can be missing or refuse writes (some TV
// browsers, Safari's "Block all cookies"): a read then answers null and a write is dropped.
//
// Key names are what's on people's devices already: never rename one (add a new setting and
// read the old one once, if a format must change).

/** How a value is kept as text. `parse` answers null for anything it doesn't recognise. */
export interface Codec<T> {
  parse(raw: string): T | null;
  format(value: T): string;
}

export interface Setting<T> {
  readonly key: string;
  readonly codec: Codec<T>;
}

const text: Codec<string> = { parse: s => s || null, format: s => s };

/** One of a fixed set of words. */
function oneOf<T extends string>(...values: readonly T[]): Codec<T> {
  return { parse: s => (values.includes(s as T) ? (s as T) : null), format: v => v };
}

const int: Codec<number> = {
  parse: s => (/^-?\d+$/.test(s) ? Number(s) : null),
  format: n => String(Math.trunc(n)),
};

/** "1"/"0". */
const flag: Codec<boolean> = {
  parse: s => (s === "1" ? true : s === "0" ? false : null),
  format: b => (b ? "1" : "0"),
};

/** JSON, kept only when `valid` accepts what was read back. */
function json<T>(valid: (v: unknown) => v is T): Codec<T> {
  return {
    parse: s => {
      try {
        const v: unknown = JSON.parse(s);
        return valid(v) ? v : null;
      } catch {
        return null;
      }
    },
    format: v => JSON.stringify(v),
  };
}

const setting = <T>(key: string, codec: Codec<T>): Setting<T> => ({ key, codec });

const isRecord = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Which subtitles to start with (phone and web): a language (null: off) and hearing-impaired. */
export interface SubtitlePref {
  language: string | null;
  sdh: boolean;
}
const isSubtitlePref = (v: unknown): v is SubtitlePref =>
  !!v &&
  typeof v === "object" &&
  "language" in v &&
  (typeof (v as SubtitlePref).language === "string" || (v as SubtitlePref).language === null);

export const SETTINGS = {
  // ---- Connection and sign-in ----
  /** The Panda server this app talks to (the Connect screen). */
  server: setting("panda.server", text),
  /** The device's own credential: lists and switches profiles. Never shown or logged. */
  deviceSecret: setting("panda.device_secret", text),
  /** The signed-in profile's session. Never shown or logged. */
  deviceToken: setting("panda.device_token", text),

  // ---- Preferences ----
  /** The app's language when the profile has none ("es", "en-US": i18n.ts reads the start). */
  language: setting("panda.lang", text),
  /** Streaming quality ("auto", or a QualityId from playback/quality.ts, checked there). */
  quality: setting("panda.quality", text),
  /** Subtitle timing per file and track ("itemId:trackKey" -> seconds), oldest first. */
  subtitleTiming: setting("panda.subtitleTiming", json(isRecord)),
  /** The phone app's subtitle choice, carried from title to title. */
  phoneSubtitles: setting("panda.mobile.subtitles", json(isSubtitlePref)),
  /** The web app's subtitle choice (its own key: /tv and /watch share a browser's storage). */
  webSubtitles: setting("panda.watch.subtitles", json(isSubtitlePref)),

  /** Request arrivals this phone has already notified about (request ids, newest last). */
  notifiedArrivals: setting(
    "panda.notified",
    json((v: unknown): v is number[] => Array.isArray(v)),
  ),

  // ---- TV display and debugging (Debug page) ----
  /** Output resolution override: 720 or 1080 (devices/resolution.ts). */
  resolution: setting("panda.res", oneOf("720", "1080")),
  /** Performance tier override (devices/tier.ts). */
  tier: setting("panda.tier", oneOf("low", "high")),
  /** Frame-rate counter on screen. */
  debugFps: setting("panda.debug.fps", flag),
  /** Renderer tracing. */
  debugTrace: setting("panda.debug.trace", flag),
} as const;

/** The audio track chosen for a title or episode, used when it plays next (every player). */
export const audioChoice = (kind: string, id: string | number): Setting<number> =>
  setting(`panda.audio.${kind}.${id}`, int);

/** The stored value, or null (unset, unreadable, or not a value this setting takes). */
export function read<T>(s: Setting<T>): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(s.key);
    return raw == null ? null : s.codec.parse(raw);
  } catch {
    return null;
  }
}

/** Keep `value`; null removes it. Dropped when storage is unavailable. */
export function write<T>(s: Setting<T>, value: T | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(s.key);
    else globalThis.localStorage?.setItem(s.key, s.codec.format(value));
  } catch {
    // No storage: it lasts until the app restarts, where the caller keeps it in memory.
  }
}
