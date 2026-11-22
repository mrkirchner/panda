/** Sorting, filtering and A-Z jumping for library grids. Pure functions, unit tested. */
import { fold } from "../text";

export interface BrowseEntry {
  key: string;
  title: string;
  year: number | null;
  rating: number | null;
  /** "Drama, Crime" */
  genres: string | null;
  /** ISO time, for "Recently added". */
  added: string;
  watched?: boolean;
}

/** `unwatched`: unwatched first, then A-Z. */
export type SortBy = "az" | "added" | "rating" | "year" | "unwatched";
export const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Sort key: lower-case, leading "The"/"A"/"An" ignored (as Plex and Apple TV do). */
export function sortKey(title: string): string {
  return title
    .trim()
    .replace(/^(the|a|an)\s+/i, "")
    .toLowerCase();
}

/** "C" for "The Crown", "#" for "2001: A Space Odyssey". */
export function letterOf(title: string): string {
  const c = sortKey(title).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

export function genresOf(entries: BrowseEntry[]): string[] {
  const all = new Set<string>();
  for (const e of entries) for (const g of (e.genres ?? "").split(",")) if (g.trim()) all.add(g.trim());
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Every word typed appears somewhere in the title ("mad 3" finds "Madagascar 3"). */
export function matchesText(title: string, text: string): boolean {
  const words = fold(text).split(" ").filter(Boolean);
  if (!words.length) return true;
  const t = fold(title);
  return words.every(w => t.includes(w));
}

export function browse<T extends BrowseEntry>(
  entries: T[],
  opts: { sort: SortBy; unwatchedOnly: boolean; genre: string | null; text?: string },
): T[] {
  const out = entries.filter(
    e =>
      (!opts.unwatchedOnly || !e.watched) &&
      (!opts.genre || (e.genres ?? "").split(",").some(g => g.trim() === opts.genre)) &&
      matchesText(e.title, opts.text ?? ""),
  );
  const byTitle = (a: T, b: T) => sortKey(a.title).localeCompare(sortKey(b.title));
  const cmp: Record<SortBy, (a: T, b: T) => number> = {
    az: byTitle,
    added: (a, b) => b.added.localeCompare(a.added) || byTitle(a, b),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byTitle(a, b),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || byTitle(a, b),
    unwatched: (a, b) => Number(!!a.watched) - Number(!!b.watched) || byTitle(a, b),
  };
  return out.sort(cmp[opts.sort]);
}

/** Index of the first entry at or after `letter` (A-Z sorted list), or -1. */
export function indexForLetter(sorted: BrowseEntry[], letter: string): number {
  const from = LETTERS.indexOf(letter);
  for (let l = from; l < LETTERS.length; l++) {
    const i = sorted.findIndex(e => letterOf(e.title) === LETTERS[l]);
    if (i >= 0) return i;
  }
  return -1;
}
