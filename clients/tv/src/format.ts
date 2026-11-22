import { normalized } from "./text";
import type { Item, TitleRating } from "./api/types";
import { lang } from "./i18n";

// Separators stay plain ASCII.
const SEP = " · ";

/**
 * What the bundled MSDF atlases can draw: ASCII, Latin-1 and Latin Extended-A (Spanish,
 * French, German, Portuguese, Nordic, Polish, Czech, ...) plus typographic punctuation. The
 * charset is set in scripts/fonts (see CLAUDE.md); keep the two in sync.
 */
const DRAWABLE =
  /[\x20-\x7E\n\u00A1-\u017F\u2018\u2019\u201A\u201C\u201D\u201E\u2013\u2014\u2026\u2022\u20AC\u2122]/u;

/**
 * Make server/TMDB text drawable with the bundled fonts. Accented Latin letters are kept
 * (`Pokémon`, `Amélie`, `año`); characters the fonts lack fall back to their base letter when
 * they have one (Vietnamese `ạ` -> `a`) and are dropped otherwise (CJK).
 */
export function displayText(s: string | null | undefined): string {
  if (!s) return "";
  let out = "";
  for (const ch of s.replace(/\u00A0/g, " ")) {
    if (DRAWABLE.test(ch)) {
      out += ch;
      continue;
    }
    for (const part of normalized(ch, "NFKD")) {
      if (DRAWABLE.test(part)) out += part;
    }
  }
  return out;
}

export const pad2 = (n: number | null | undefined) => String(n ?? 0).padStart(2, "0");

function runtime(secs: number | null): string | null {
  if (!secs) return null;
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/**
 * Resolution label from the *width*: scope films are 1920x800 or 3840x1600 but are still
 * "1080p" / "4K" releases.
 */
export function resolutionLabel(width: number | null, height: number | null): string | null {
  const w = Math.max(width ?? 0, ((height ?? 0) * 16) / 9);
  if (!w) return null;
  if (w >= 3200) return "4K";
  if (w >= 2400) return "1440p";
  if (w >= 1700) return "1080p";
  if (w >= 1100) return "720p";
  return "SD";
}

function quality(item: Item): string | null {
  const res = resolutionLabel(item.width, item.height);
  const HDR_LABELS: Record<string, string> = { hdr10: "HDR10", hlg: "HLG", dolbyvision: "Dolby Vision" };
  const hdr = item.dynamic_range ? (HDR_LABELS[item.dynamic_range] ?? null) : null;
  return [res, hdr].filter(Boolean).join(" ") || null;
}

const rating = (r: number | null) => (r ? `${r.toFixed(1)}/10` : null);

/**
 * "TMDB 7.8/10  |  IMDb 8.3/10  |  RT 91%": a title's ratings as the server sends them (TMDB's,
 * then OMDb's minus any the admin switched off), with their short names. Three fit a Details
 * column. Without them (before a title's details arrive, or a title not in the library), TMDB's
 * `score` alone (0 is "no votes yet": none).
 */
/** TMDB's score as the one rating, before a title's details (with every rating) arrive. 0 is
 * "no votes yet": none. */
export function tmdbRating(score: number | null | undefined): TitleRating[] {
  return score ? [{ source: "tmdb", label: "TMDB", short: "TMDB", value: `${score.toFixed(1)}/10` }] : [];
}

export function movieMeta(item: Item): string {
  return [item.year, runtime(item.duration_secs), item.genres, rating(item.rating), quality(item)]
    .filter(Boolean)
    .join(SEP);
}

export function episodeMeta(item: Item): string {
  const se = item.episode != null ? `S${pad2(item.season)}E${pad2(item.episode)}` : `Season ${item.season}`;
  return [se, runtime(item.duration_secs), quality(item)].filter(Boolean).join(SEP);
}

/** Playback clock: `m:ss` or `h:mm:ss`. */
export function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Three-letter (ISO 639-2, as files tag tracks) to two-letter codes, for language names. */
const ISO639_2: Record<string, string> = {
  eng: "en",
  spa: "es",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  ita: "it",
  por: "pt",
  jpn: "ja",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  rus: "ru",
  dut: "nl",
  nld: "nl",
  swe: "sv",
  nor: "no",
  nob: "nb",
  dan: "da",
  fin: "fi",
  pol: "pl",
  tur: "tr",
  ara: "ar",
  heb: "he",
  hin: "hi",
  tha: "th",
  vie: "vi",
  ind: "id",
  gre: "el",
  ell: "el",
  cze: "cs",
  ces: "cs",
  hun: "hu",
  rum: "ro",
  ron: "ro",
  ukr: "uk",
};

/** "March 1, 2024" in the app's language (falls back to the ISO date). */
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString(lang(), {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** "English" for "en" (the code itself where the TV has no names for languages). */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  // Files tag tracks with three-letter codes (ISO 639-2): the common ones by their two-letter one.
  code = ISO639_2[code.toLowerCase()] ?? code;
  if (code === "und") return null;
  try {
    // Not in every TV browser (nor in this TS lib): checked at runtime.
    const Names = (
      Intl as unknown as {
        DisplayNames?: new (l: string[], o: { type: string }) => { of: (c: string) => string | undefined };
      }
    ).DisplayNames;
    return Names ? (new Names([lang()], { type: "language" }).of(code) ?? code) : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
