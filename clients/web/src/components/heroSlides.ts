// Hero slides from what the server features: Home's (`Featured`, with a show's next episode) and
// the browse pages' (`Spot`), as the phone app builds them.
import { api } from "@tv/api/client";
import type { Featured, Spot, Title } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t, tn } from "@tv/i18n";
import { facts, genres, message, runtime } from "../data";
import { href, paths } from "../nav";
import { play, playShow, resumeAt } from "../player/launch";
import type { HeroSlide } from "./Hero";
import { toast } from "./ui";

const failed = (e: unknown) => toast(message(e));

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
      overview: m.overview,
      ratings: feat.ratings?.length ? feat.ratings : tmdbRating(m.rating),
      clip: { kind: "title", id: m.id },
      playLabel: at > 0 ? t("Resume") : t("Play"),
      play: () => play({ kind: "title", id: m.id }, at),
      infoHref: href(paths.title(m.id)),
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
    facts: facts([s.year, tn(s.seasons, "{n} season", "{n} seasons"), genres(s.genres)]),
    overview: s.overview,
    ratings: feat.ratings?.length ? feat.ratings : tmdbRating(s.rating),
    clip: { kind: "series", name: s.series },
    playLabel: next
      ? `${next.position_secs > 0 ? t("Resume") : t("Play")} S${next.season}:E${next.episode}`
      : t("Play"),
    play: () =>
      next
        ? play({ kind: "item", id: next.item_id }, next.position_secs)
        : void playShow(s.series).catch(failed),
    infoHref: href(paths.series(s.series)),
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
          ? api.title(s.id).then((m) => play({ kind: "title", id: m.id }, resumeAt(m)))
          : playShow(s.id)
      ).catch(failed),
    infoHref: href(paths.spot(s)),
  };
}
