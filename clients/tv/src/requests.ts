import type { MyRequest, TierProgress } from "./api/types";
import type { BadgeTone } from "./components/Cards";
import { t } from "./i18n";

/** The furthest-along server's progress (a request goes to HD and 4K at once). */
export function bestProgress(r: MyRequest): TierProgress["progress"] {
  const order = { searching: 0, downloading: 1, importing: 2, available: 3 } as const;
  let best: TierProgress["progress"] = null;
  for (const t of r.tiers) {
    const p = t.progress;
    if (!p) continue;
    if (
      !best ||
      order[p.state] > order[best.state] ||
      (p.state === best.state && p.fraction > best.fraction)
    ) {
      best = p;
    }
  }
  return best;
}

/** Short status for a request's tile: "Downloading 42%", "Ready", ... */
export function requestLabel(r: MyRequest): string {
  if (r.title_id || r.series) return t("Ready");
  if (r.status === "failed") return t("Failed");
  const p = bestProgress(r);
  if (!p) return t("Requested");
  switch (p.state) {
    case "searching":
      return t("Searching");
    case "downloading":
      return t("Downloading {p}%", { p: Math.round(p.fraction * 100) });
    case "importing":
      return t("Importing");
    case "available":
      return t("Ready");
  }
}

/**
 * The badge on a My List tile while the request is on its way, like other tiles' (Requested,
 * Searching, Downloading 42%, Importing; Downloaded once a server has it but the library
 * doesn't yet). None once it's in the library: it's an ordinary title then.
 */
export function requestBadge(r: MyRequest): { label: string; tone: BadgeTone } | undefined {
  if (r.title_id || r.series) return undefined;
  const available = bestProgress(r)?.state === "available";
  return {
    label: available ? t("Downloaded") : requestLabel(r),
    tone: available ? "done" : "pending",
  };
}

/** Still on its way (worth refreshing): not in the library and not failed. */
export const inFlight = (r: MyRequest) => !r.title_id && !r.series && r.status !== "failed";
