/** Title predictions while typing on a remote: best matches for a partial query. */

import { fold } from "../text";

/** Lowercase, accents stripped, punctuation as spaces (re-exported for callers of this module). */
export { fold };

/**
 * Up to `limit` titles matching what's typed: titles starting with it first, then titles with
 * a word starting with it (so "wars" finds "Star Wars"); every typed word must start a word.
 * Leading "the"/"a" don't count against a title ("matrix" finds "The Matrix" first).
 */
export function suggest(titles: string[], query: string, limit = 5): string[] {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(" ");
  const seen = new Set<string>();
  const scored: { title: string; score: number }[] = [];
  for (const title of titles) {
    const t = fold(title);
    if (!t || seen.has(t)) continue;
    const bare = t.replace(/^(the|a|an) /, "");
    const tw = t.split(" ");
    const allWords = words.every((w, i) =>
      i === words.length - 1 ? tw.some(x => x.startsWith(w)) : tw.includes(w),
    );
    let score = -1;
    if (t.startsWith(q)) score = 0;
    else if (bare.startsWith(q)) score = 1;
    else if (allWords) score = 2;
    if (score < 0) continue;
    seen.add(t);
    scored.push({ title, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.title.length - b.title.length || a.title.localeCompare(b.title),
  );
  return scored.slice(0, limit).map(s => s.title);
}
