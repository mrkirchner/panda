// Your requests (`/api/requests/mine`, with each server's download progress), one list for the
// whole app: asked once, again on `refreshAll()`, and every REQUESTS_POLL_MS while any is on its
// way (as the TV's Home does). Shared with the phone app (../mobile/app/requests.ts). What a title you don't have says about itself: Request,
// Requested, Searching, Downloading 42%, Downloaded (the TV's discoverStatus.ts / requests.ts).
import { api } from "@tv/api/client";
import type { Discover, MyRequest, TierProgress } from "@tv/api/types";
import { t } from "@tv/i18n";
import { createRoot, createSignal } from "solid-js";
import { refreshHooks } from "./data";

/** The TV's polling while something is on its way. */
const REQUESTS_POLL_MS = 20_000;

const store = createRoot(() => {
  const [mine, setMine] = createSignal<MyRequest[]>([]);
  return { mine, setMine };
});
let asked = false;
let poll: ReturnType<typeof setTimeout> | undefined;

/** Ask again now (after a request, a cancel, or anything else that changes them). */
export async function refreshRequests() {
  asked = true;
  clearTimeout(poll);
  try {
    const list = await api.myRequests();
    store.setMine(list);
    if (list.some(inFlight)) poll = setTimeout(() => void refreshRequests(), REQUESTS_POLL_MS);
  } catch {
    // Kept as they were; asked again on the next refresh.
  }
}
refreshHooks.add(() => void refreshRequests());

/** Your requests (loaded on first use). */
export function myRequests(): MyRequest[] {
  if (!asked) void refreshRequests();
  return store.mine();
}

/** Still on its way (worth refreshing): not in the library and not failed. */
export const inFlight = (r: MyRequest) => !r.title_id && !r.series && r.status !== "failed";

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

/** "Downloading 42%", "Ready", "Failed"... (the TV's requestLabel). */
export function requestLabel(r: MyRequest): string {
  if (r.title_id || r.series) return t("Ready");
  if (r.status === "failed") return t("Failed");
  const p = bestProgress(r);
  if (!p) return t("Requested");
  if (p.state === "searching") return t("Searching");
  if (p.state === "downloading") return t("Downloading {p}%", { p: Math.round(p.fraction * 100) });
  if (p.state === "importing") return t("Importing");
  return t("Ready");
}

/** The badge on a request's tile: Downloaded once a server has it, else its label. */
export function requestBadge(r: MyRequest): string | undefined {
  if (r.title_id || r.series) return undefined;
  return bestProgress(r)?.state === "available" ? t("Downloaded") : requestLabel(r);
}

/** What a title you don't have says: its label, the download's progress, and whether it can be
 * asked for. */
export function discoverStatus(d: Discover): { label: string | undefined; action: boolean; progress: number } {
  if (d.downloaded) return { label: t("Downloaded"), action: false, progress: 0 };
  const r = myRequests().find(x => x.kind === d.kind && x.tmdb_id === d.tmdb_id);
  const p = r ? bestProgress(r) : null;
  if (p?.state === "downloading")
    return { label: t("Downloading {p}%", { p: Math.round(p.fraction * 100) }), action: false, progress: p.fraction };
  if (p?.state === "importing") return { label: t("Importing"), action: false, progress: 0 };
  if (p?.state === "searching") return { label: t("Searching"), action: false, progress: 0 };
  if (d.requested || r) return { label: t("Requested"), action: false, progress: 0 };
  if (d.can_request) return { label: t("Request"), action: true, progress: 0 };
  return { label: undefined, action: false, progress: 0 };
}

/** Your request for `d`, if you made one. */
export const requestFor = (d: Discover) => myRequests().find(x => x.kind === d.kind && x.tmdb_id === d.tmdb_id);
