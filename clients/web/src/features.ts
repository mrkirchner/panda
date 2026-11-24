// What the server has set up (`/api/features`): requests per kind, TMDB, mail. Asked once; the
// app only offers what works, following the server's flags (as the TV does).
import { api } from "@tv/api/client";

type Features = Awaited<ReturnType<typeof api.features>>;
let asked: Promise<Features | null> | null = null;
/** Asked once per sign-in; a failed lookup is asked again next time (not kept as "nothing"). */
export const features = () =>
  (asked ??= api.features().catch(() => {
    asked = null;
    return null;
  }));

/** The server's libraries (asked once: Movies, Shows and the All grid all want them). */
let libs: ReturnType<typeof api.libraries> | null = null;
export const libraries = () =>
  (libs ??= api.libraries().catch(() => {
    libs = null;
    return [];
  }));

/** Another profile, account or server: features and libraries are asked again. */
export function resetStores() {
  asked = null;
  libs = null;
}
