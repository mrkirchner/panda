// Opening a title, a show, a genre or a list from anywhere (pushes onto the current tab).
import type { Spot } from "@tv/api/types";
import { open } from "../nav";
import { allScreen } from "./All";
import { browseScreen } from "./Browse";
import { seriesScreen } from "./Series";
import { titleScreen } from "./Title";
import { personScreen } from "./Person";
import { previewScreen } from "./Preview";
import { api } from "@tv/api/client";
import { t } from "@tv/i18n";

export const openTitle = (id: string) => open(() => titleScreen(id), { title: "" });
export const openSeries = (name: string) => open(() => seriesScreen(name), { title: "" });
export const openSpot = (s: Spot) => (s.kind === "movie" ? openTitle(s.id) : openSeries(s.id));
export const openGenre = (name: string) =>
  open(() => browseScreen(() => api.genrePage(name), null), { title: t(name) });
export const openAll = (kind: "movies" | "shows", genre?: string) =>
  open(() => allScreen(kind, genre), { title: kind === "movies" ? t("All movies") : t("All shows") });
export const openPerson = (id: number) => open(() => personScreen(id), { title: "" });
/** A title you don't have: its page, with Request. */
export const openPreview = (kind: "movie" | "series", tmdbId: number) =>
  open(() => previewScreen(kind, tmdbId), { title: "" });
