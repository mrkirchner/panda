// Your requests (`/api/requests/mine`, with each server's download progress) and what a title you
// don't have says about itself: Request, Requested, Searching, Downloading 42%, Downloaded (the
// TV's ../tv/src/discoverStatus.ts, without its Solid 1 resource).
import { api } from "@tv/api/client";
import type { Discover, MyRequest, TierProgress } from "@tv/api/types";
import { t } from "@tv/i18n";
import { createSignal } from "solid-js";

export function requestStatus() {
  const [mine, setMine] = createSignal<MyRequest[]>([]);
  const refresh = () =>
    api.myRequests().then(
      r => setMine(r),
      () => {},
    );
  void refresh();
  const find = (d: Discover) => mine().find(r => r.kind === d.kind && r.tmdb_id === d.tmdb_id);
  /** Its label (undefined: nothing to say, e.g. no Radarr/Sonarr), and whether it can be asked for. */
  const status = (d: Discover): { label: string | undefined; action: boolean } => {
    if (d.downloaded) return { label: t("Downloaded"), action: false };
    const r = find(d);
    const p = r ? bestProgress(r) : null;
    if (p?.state === "downloading")
      return { label: t("Downloading {p}%", { p: Math.round(p.fraction * 100) }), action: false };
    if (p?.state === "importing") return { label: t("Importing"), action: false };
    if (p?.state === "searching") return { label: t("Searching"), action: false };
    if (d.requested || r) return { label: t("Requested"), action: false };
    if (d.can_request) return { label: t("Request"), action: true };
    return { label: undefined, action: false };
  };
  return Object.assign(status, { mine, find, refresh });
}

/** The furthest-along server's progress (a request goes to HD and 4K at once). As
 * ../tv/src/requests.ts, which can't be imported here (its card types pull in the TV's UI). */
export function bestProgress(r: MyRequest): TierProgress["progress"] {
  const order = { searching: 0, downloading: 1, importing: 2, available: 3 } as const;
  let best: TierProgress["progress"] = null;
  for (const tier of r.tiers) {
    const p = tier.progress;
    if (!p) continue;
    if (!best || order[p.state] > order[best.state] || (p.state === best.state && p.fraction > best.fraction)) {
      best = p;
    }
  }
  return best;
}
