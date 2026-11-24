// "Dune is ready to watch": requests of this profile that arrived (the server's
// /api/notifications), each notified once on this phone, run by the OS in the background
// (platform.notifications.watch: Android's WorkManager, iOS's background refresh).
import { api } from "@tv/api/client";
import { getToken } from "@tv/api/session";
import type { Arrival } from "@tv/api/types";
import { t } from "@tv/i18n";
import { SETTINGS, read, write } from "@tv/platform/settings";
import type { Notifications } from "@tv/platform/types";

/** Ids remembered (the newest): plenty, and small. */
const REMEMBERED = 100;

const path = (a: Arrival) =>
  a.title_id ? `/title/${a.title_id}` : a.series ? `/series/${a.series}` : undefined;

/** Notify the arrivals not notified yet. Quiet without a session (signed out). */
export async function checkArrivals(notifications: Notifications): Promise<void> {
  if (!getToken()) return;
  const arrivals = await api.notifications();
  const done = read(SETTINGS.notifiedArrivals) ?? [];
  const fresh = arrivals.filter(a => !done.includes(a.id));
  const shown: number[] = [];
  for (const a of fresh) {
    // Only what was shown is remembered (allowed later, the rest still comes).
    const ok = await notifications.show({
      id: `arrival-${a.id}`,
      title: t("{title} is ready to watch", { title: a.title }),
      body: a.kind === "series" ? t("The show you asked for is in Panda now.") : t("The movie you asked for is in Panda now."),
      open: path(a),
    });
    if (ok) shown.push(a.id);
  }
  if (shown.length) write(SETTINGS.notifiedArrivals, [...done, ...shown].slice(-REMEMBERED));
}
