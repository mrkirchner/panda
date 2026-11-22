/**
 * Text folding that also works on engines without ICU data (Apple TV's NativeScript V8, some
 * older TV browsers): no `\p{...}` regex literals (a parse error there, which breaks the whole
 * bundle) and no unguarded `String.prototype.normalize`. Unicode classes are used when the
 * engine supports them, otherwise explicit ranges that cover Latin, Greek, Cyrillic and CJK.
 *
 * Ranges are built from code points (not written as literal characters or `\u` escapes in a
 * regex literal) so the source stays plain ASCII.
 */

const unicodeRegex = (source: string, flags: string): RegExp | null => {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

/** `[a-b c-d ...]` from code point pairs, as regex source. */
const ranges = (pairs: [number, number][]) =>
  pairs
    .map(([a, b]) => `\\u${a.toString(16).padStart(4, "0")}-\\u${b.toString(16).padStart(4, "0")}`)
    .join("");

/** Combining marks (accents after NFD): the common blocks, which is what titles use. */
const MARKS = new RegExp(
  `[${ranges([
    [0x0300, 0x036f],
    [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff],
    [0x20d0, 0x20ff],
    [0xfe20, 0xfe2f],
  ])}]`,
  "g",
);

/** Letters and digits outside ASCII, for engines without `\p{L}`. */
const WORD_RANGES = ranges([
  [0x00c0, 0x00d6],
  [0x00d8, 0x00f6],
  [0x00f8, 0x02af],
  [0x0370, 0x03ff],
  [0x0400, 0x052f],
  [0x0590, 0x06ff],
  [0x0e00, 0x0e7f],
  [0x1100, 0x11ff],
  [0x3040, 0x30ff],
  [0x3400, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
]);

/** Runs of anything that isn't a letter or digit. */
const NON_WORD = unicodeRegex("[^\\p{L}\\p{N}]+", "gu") ?? new RegExp(`[^0-9A-Za-z${WORD_RANGES}]+`, "g");

/** One character a keyboard can type: letters, digits, punctuation, symbols, space. */
export const TYPABLE =
  unicodeRegex("^[\\p{L}\\p{N}\\p{P}\\p{S} ]$", "u") ??
  new RegExp(`^[\\u0020-\\u007e${WORD_RANGES}${ranges([[0x2010, 0x205e]])}]$`);

/** `s.normalize(form)`, or `s` unchanged where the engine has no normalization data. */
export function normalized(s: string, form: "NFD" | "NFKD" = "NFD"): string {
  try {
    return typeof s.normalize === "function" ? s.normalize(form) : s;
  } catch {
    return s;
  }
}

/** Lowercase, accents stripped, punctuation as spaces: what search and filters compare. */
export const fold = (s: string): string =>
  normalized(s, "NFD").replace(MARKS, "").toLowerCase().replace(NON_WORD, " ").trim();
