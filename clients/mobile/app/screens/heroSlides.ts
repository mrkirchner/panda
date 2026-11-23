// Hero slides from what the server features: Home's (`Featured`, with a show's next episode)
// and the browse pages' (`Spot`).
import { Dialogs } from "@nativescript/core";
import { api } from "@tv/api/client";
import type { Featured, Spot, Title } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { facts, runtime } from "../data";
import { play } from "../player";
import type { HeroSlide } from "./Hero";
import { openSeries, openSpot, openTitle } from "./links";
import { nextUp } from "./Series";

const genres = (g: string | null | undefined) =>
  (g ?? "")
    .split(/,\s*/)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
const failed = (e: unknown) => void Dialogs.alert(e instanceof Error ? e.message : String(e));
const resumeAt = (m: Title) => (m.progress && !m.progress.finished && m.progress.position_secs > 30 ? m.progress.position_secs : 0);

/** A show from its next episode (in progress, else the first not watched). */
async function playShow(name: string) {
  const eps = (await api.items({ series: name, kind: "episode", limit: 10000 })).sort(
    (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
  );
  const e = nextUp(eps);
  if (!e) return openSeries(name);
  const p = e.progress;
  await play({ kind: "item", id: e.id }, p && !p.finished ? p.position_secs : 0);
}

export function featuredSlide(f: Featured | Title): HeroSlide {
  const feat: Featured = "kind" in f ? { reason: "Recently added", movie: f } : f;
  const m = feat.movie;
  if (m) {
    const at = resumeAt(m);
    return {
      key: m.id,
      title: m.title,
      logo: feat.logo ?? null,
      backdrop: m.backdrop,
      reason: t(feat.reason),
      facts: facts([m.year, runtime(m.duration_secs), genres(m.genres)]),
      ratings: feat.ratings?.length ? feat.ratings : tmdbRating(m.rating),
      clip: { kind: "title", id: m.id },
      playLabel: at > 0 ? t("Resume") : t("Play"),
      play: () => void play({ kind: "title", id: m.id }, at).catch(failed),
      info: () => openTitle(m.id),
    };
  }
  const s = feat.series!;
  const next = s.next;
  return {
    key: s.series,
    title: s.meta_title ?? s.series,
    logo: feat.logo ?? null,
    backdrop: s.backdrop,
    reason: t(feat.reason),
    facts: facts([s.year, t("{n} seasons", { n: s.seasons }), genres(s.genres)]),
    ratings: feat.ratings?.length ? feat.ratings : tmdbRating(s.rating),
    clip: { kind: "series", name: s.series },
    playLabel: next
      ? `${next.position_secs > 0 ? t("Resume") : t("Play")} S${next.season}:E${next.episode}`
      : t("Play"),
    play: () =>
      void (next ? play({ kind: "item", id: next.item_id }, next.position_secs) : playShow(s.series)).catch(failed),
    info: () => openSeries(s.series),
  };
}

export function spotSlide(s: Spot): HeroSlide {
  return {
    key: `${s.kind}:${s.id}`,
    title: s.title,
    logo: s.logo,
    backdrop: s.backdrop,
    reason: t(s.reason, { title: s.reason_title ?? "" }),
    facts: facts([s.year, genres(s.genres)]),
    ratings: tmdbRating(s.rating),
    clip: s.kind === "movie" ? { kind: "title", id: s.id } : { kind: "series", name: s.id },
    play: () =>
      void (
        s.kind === "movie"
          ? api.title(s.id).then(m => play({ kind: "title", id: m.id }, resumeAt(m)))
          : playShow(s.id)
      ).catch(failed),
    info: () => openSpot(s),
  };
}
