import { tier } from "#devices/tier";
import { imageUrl } from "./api/client";
import type { Spot } from "./api/types";
import { t } from "./i18n";

/** "Movie · Drama · Comedy" on a feature card or banner. */
export const spotMeta = (s: Spot) =>
  [
    s.kind === "movie" ? t("Movie") : t("Show"),
    ...(s.genres ?? "")
      .split(",")
      .map(g => g.trim())
      .filter(Boolean)
      .slice(0, 2),
  ].join(" · ");

/** Why it's featured: "Top rated", "Because you watched Heat"... */
export const spotReason = (s: Spot) => t(s.reason, { title: s.reason_title ?? "" });

/** Title logos cost texture memory: low-tier TVs show the name instead. */
export const logoOf = (s: Spot) => (tier === "high" && s.logo ? imageUrl(s.logo) : undefined);

/** A featured title's page. */
export const spotPath = (s: Spot) =>
  s.kind === "movie" ? `/title/${encodeURIComponent(s.id)}` : `/series/${encodeURIComponent(s.id)}`;
