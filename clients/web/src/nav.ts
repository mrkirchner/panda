// Addresses of the app's pages, and moving between them from anywhere (cards, the hero, the
// player). Pages are real URLs (history routing under the app's base), so links open in a new
// tab, Back works, and a page can be bookmarked.
import type { Navigator } from "@solidjs/router";
import type { Spot } from "@tv/api/types";

/** The app's base without its trailing slash ("/watch", or "" when hosted at the root). */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

let navigator: Navigator | null = null;
/** The shell hands over the router's navigate once it exists. */
export const setNavigator = (n: Navigator) => (navigator = n);

/** Go to an app path ("/title/m1"). The router's navigate takes the full path (with the base). */
export function go(path: string, opts: { replace?: boolean } = {}) {
  navigator?.(href(path), opts);
}

/** Back to the previous page, or Home when this is the first page of the visit. */
export function back(fallback = "/") {
  const depth = (history.state as { _depth?: number } | null)?._depth;
  if (depth !== undefined && firstDepth !== null && depth > firstDepth) history.back();
  else go(fallback, { replace: true });
}

/** The history depth of this visit's first page (the router's `_depth` counts the whole tab's). */
let firstDepth: number | null = null;
export function markFirstEntry() {
  firstDepth ??= (history.state as { _depth?: number } | null)?._depth ?? 0;
}

/** The router's pathname (which includes the base) as an app path: "/watch/title/m1" -> "/title/m1". */
export const appPath = (pathname: string) =>
  (BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname) || "/";

/** Where to go after signing in or choosing a profile (`?next=`): an app path, never another site. */
export const nextPath = (next: string | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

/** An app path as an href (with the base), for real links. */
export const href = (path: string) => `${BASE}${path}`;

const enc = encodeURIComponent;
export const paths = {
  home: "/",
  movies: "/movies",
  shows: "/shows",
  search: (q?: string) => (q ? `/search?q=${enc(q)}` : "/search"),
  myList: "/my-list",
  profiles: "/profiles",
  editProfile: "/profile",
  signIn: "/sign-in",
  connect: "/connect",
  title: (id: string) => `/title/${enc(id)}`,
  series: (name: string) => `/series/${enc(name)}`,
  spot: (s: Pick<Spot, "kind" | "id">) =>
    s.kind === "movie" ? `/title/${enc(s.id)}` : `/series/${enc(s.id)}`,
  person: (id: number) => `/person/${id}`,
  preview: (kind: "movie" | "series", tmdbId: number) => `/discover/${kind}/${tmdbId}`,
  genre: (name: string) => `/genre/${enc(name)}`,
  library: (id: number) => `/library/${id}`,
  all: (kind: "movies" | "shows", opts: { genre?: string; library?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.genre) q.set("genre", opts.genre);
    if (opts.library !== undefined) q.set("library", String(opts.library));
    const s = q.toString();
    return `/${kind}/all${s ? `?${s}` : ""}`;
  },
};
