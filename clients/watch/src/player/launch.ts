// Starting playback from anywhere: the player is a page (/play/title/:id or /play/item/:id), so
// Back closes it and a playing title can be reloaded or shared within the account.
import { api } from "@tv/api/client";
import type { Item, Title } from "@tv/api/types";
import { go } from "../nav";

export type PlayTarget = { kind: "title"; id: string; version?: number } | { kind: "item"; id: number };

/** Play `target` from `startSecs`. `after`: the page to land on when the player closes (Continue
 * Watching passes the title's, so you land where you can mark it watched). */
export function play(target: PlayTarget, startSecs = 0, after?: string) {
  const q = new URLSearchParams();
  if (startSecs > 0) q.set("start", String(Math.floor(startSecs)));
  if (target.kind === "title" && target.version !== undefined) q.set("version", String(target.version));
  if (after) q.set("back", after);
  const s = q.toString();
  go(`/play/${target.kind}/${encodeURIComponent(String(target.id))}${s ? `?${s}` : ""}`);
}

/** Where a movie picks up: its saved position, unless it's finished or barely begun. */
export const resumeAt = (m: Pick<Title, "progress">) =>
  m.progress && !m.progress.finished && m.progress.position_secs > 30 ? m.progress.position_secs : 0;

/** Episode order, Specials (season 0) last, as the TV lists them. */
export function sortEpisodes(eps: Item[]): Item[] {
  const season = (e: Item) => (e.season === 0 ? Number.MAX_SAFE_INTEGER : (e.season ?? 0));
  return [...eps].sort((a, b) => season(a) - season(b) || (a.episode ?? 0) - (b.episode ?? 0));
}

/**
 * What Play plays for a show, as on the TV: the episode you watched last if it's unfinished, else
 * the first one not watched, else the first; never a Special unless the show has nothing else.
 */
export function nextUp(eps: Item[]): Item | undefined {
  const regular = eps.filter((e) => e.season !== 0);
  const pool = regular.length ? regular : eps;
  const started = pool
    .filter((e) => e.progress && !e.progress.finished && e.progress.position_secs > 30)
    .sort((a, b) => (b.progress?.last_played_at ?? 0) - (a.progress?.last_played_at ?? 0));
  return started[0] ?? pool.find((e) => !e.progress?.finished) ?? pool[0];
}

/** Play a show from its next episode. */
export async function playShow(name: string, after?: string) {
  const e = nextUp(sortEpisodes(await api.items({ series: name, kind: "episode", limit: 10000 })));
  if (!e) return go(`/series/${encodeURIComponent(name)}`);
  const p = e.progress;
  play({ kind: "item", id: e.id }, p && !p.finished ? p.position_secs : 0, after);
}
