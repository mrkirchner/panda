import { createResource } from "solid-js";
import { api } from "./api/client";
import type { Discover, MyRequest } from "./api/types";
import type { BadgeTone } from "./components/Cards";
import { t } from "./i18n";
import { bestProgress } from "./requests";

/** How a title you don't have shows on its tile (and its page's button). */
export interface DiscoverStatus {
  label: string | undefined;
  tone: BadgeTone;
  /** 0-1 while downloading (the tile's progress bar). */
  progress: number;
}

/**
 * Status for tiles of titles you don't have: Request (you can), Requested / Searching /
 * Downloading 42% / Importing (on its way: your request's live progress), or Downloaded. One
 * fetch of your requests per page.
 */
export function createDiscoverStatus() {
  const [mine, { refetch }] = createResource(() => api.myRequests().catch(() => [] as MyRequest[]));
  const find = (d: Discover) => mine()?.find(r => r.kind === d.kind && r.tmdb_id === d.tmdb_id);
  const status = (d: Discover): DiscoverStatus => {
    if (d.downloaded) return { label: t("Downloaded"), tone: "done", progress: 0 };
    const p = (() => {
      const r = find(d);
      return r ? bestProgress(r) : null;
    })();
    if (p?.state === "downloading")
      return {
        label: t("Downloading {p}%", { p: Math.round(p.fraction * 100) }),
        tone: "pending",
        progress: p.fraction,
      };
    if (p?.state === "importing") return { label: t("Importing"), tone: "pending", progress: 0 };
    if (p?.state === "searching") return { label: t("Searching"), tone: "pending", progress: 0 };
    if (d.requested || find(d)) return { label: t("Requested"), tone: "pending", progress: 0 };
    if (d.can_request) return { label: t("Request"), tone: "action", progress: 0 };
    return { label: undefined, tone: "pending", progress: 0 };
  };
  return Object.assign(status, {
    /** Your request for it, if you made one. */
    requestFor: find,
    /** Load your requests again (after cancelling one). */
    refresh: () => void refetch(),
  });
}
