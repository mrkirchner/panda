// What the server has set up (`/api/features`): requests per kind, TMDB, mail. Asked once; the
// app only offers what works, following the server's flags (as the TV does).
import { api } from "@tv/api/client";

type Features = Awaited<ReturnType<typeof api.features>>;
let asked: Promise<Features | null> | null = null;
export const features = () => (asked ??= api.features().catch(() => null));

/** The server's libraries (asked once: Movies, Shows and the All grid all want them). */
let libs: ReturnType<typeof api.libraries> | null = null;
export const libraries = () => (libs ??= api.libraries().catch(() => {
  libs = null;
  return [];
}));
