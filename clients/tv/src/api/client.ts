import { trace } from "#devices/debug";
import type { BitmapManifest } from "../playback/bitmapSubs";
import { getServer } from "./server";
import { deviceLang, setLang, t } from "../i18n";
import {
  getDeviceSecret,
  getToken,
  imageToken,
  setCurrentUser,
  setDeviceSecret,
  setImageToken,
  setToken,
  signedOut,
} from "./session";
import type {
  SubtitleTrack,
  Person,
  GenrePage,
  ClientProfile,
  CollectionView,
  Credit,
  DeviceProfile,
  Discover,
  DiscoverSet,
  FindResults,
  Home,
  HomeMore,
  Item,
  Library,
  Me,
  MyListEntry,
  MyRequest,
  PersonPage,
  Playback,
  Preview,
  Progress,
  SeriesSummary,
  Title,
  TitleDetails,
  User,
  Arrival,
} from "./types";

/** Panda server origin (see api/server.ts). */
export const absolute = (path: string) => (path.startsWith("http") ? path : (getServer() ?? "") + path);

export class AuthError extends Error {}

const authHeaders = (): Record<string, string> => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

/** A non-2xx response, with its status for callers that branch on it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What to say when a PIN was refused (the server answers "wrong PIN", or too many tries). */
export function pinMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /too many/i.test(m)
    ? t("Too many tries. Wait a few minutes.")
    : /wrong/i.test(m)
      ? t("Wrong PIN")
      : m;
}

/** How long one attempt may take before it's abandoned (writes may do slow work server-side). */
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
/** Reads are retried this many times after a timeout or network error (writes never are). */
const READ_RETRIES = 2;

class TimeoutError extends Error {}

/**
 * `fetch` that can't hang: a request with no answer is abandoned after its time limit, and
 * a read (GET) is tried again. On Apple TV the app's first request after launch can stall
 * forever (the first connection to the local network), which left Home loading for good.
 */
/** `RequestInit` plus this request's own time limit (slow server-side work, like a subtitle search). */
type Init = RequestInit & { timeoutMs?: number };

async function fetchWithTimeout(url: string, init: Init, attempt = 0): Promise<Response> {
  const read = (init.method ?? "GET").toUpperCase() === "GET";
  const limit = init.timeoutMs ?? (read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new TimeoutError(`no answer in ${limit / 1000}s`));
    }, limit);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: init.signal ?? ctrl?.signal }), timeout]);
  } catch (e) {
    if (read && attempt < READ_RETRIES && !init.signal?.aborted)
      return fetchWithTimeout(url, init, attempt + 1);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init?: Init): Promise<T> {
  const started = Date.now();
  const shown = `${init?.method ?? "GET"} ${path.replace(/\?.*$/, "")}`;
  trace(`-> ${shown}`);
  const res = await fetchWithTimeout(absolute(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...init?.headers },
  }).catch((e: unknown) => {
    trace(`xx ${shown} failed after ${Date.now() - started}ms: ${String(e)}`);
    throw e;
  });
  trace(`<- ${shown} ${res.status} in ${Date.now() - started}ms`);
  if (res.status === 401 && !path.startsWith("/api/auth/device/")) {
    signedOut();
    throw new AuthError("signed out");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HttpError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

/** Signed URL for a cached artwork key, or undefined when there is none. */
export const imageUrl = (key: string | null | undefined) => {
  const t = imageToken();
  return key && t ? absolute(`/api/images/${key}?t=${encodeURIComponent(t)}`) : undefined;
};

/**
 * Apple TV: hand the Top Shelf extension (which runs outside the app) the server and a token
 * for this profile's rows: read-only, `/api/topshelf/` only, 7 days, renewed on every start.
 */
function syncTopShelf(): void {
  const shelf = (globalThis as unknown as { pandaTopShelf?: { update(server: string, token: string): void } })
    .pandaTopShelf;
  const server = getServer();
  if (!shelf || !server) return;
  request<{ token: string }>("/api/auth/topshelf-token", { method: "POST", body: "{}" })
    .then(r => shelf.update(server, r.token))
    .catch(() => {});
}

let mePromise: Promise<Me> | null = null;

/** Make a profile current: its name and avatar, and its language for the whole app. */
export function applyProfile(u: User) {
  setCurrentUser({
    id: u.id,
    username: u.username,
    name: u.display_name || u.username,
    language: u.language,
    avatar: u.avatar,
    primary: u.id === u.account_id,
    email: u.email ?? null,
    canSignIn: !u.managed,
    previewSound: u.preview_sound !== false,
  });
  setLang(u.language === "es" || u.language === "en" ? u.language : deviceLang());
}

/** Load the signed-in user (and the artwork token) once per session. */
export function ensureSession(): Promise<Me> {
  if (!getToken()) {
    // Not signed in on this TV: go to sign-in rather than leave pages waiting.
    signedOut();
    return Promise.reject(new AuthError("not signed in"));
  }
  mePromise ??= request<Me>("/api/auth/me")
    .then(me => {
      setImageToken(me.image_token);
      syncTopShelf();
      applyProfile(me.user);
      // TVs signed in before device pairing existed get their device credential once, so they
      // gain the profile picker without pairing again. Browsers/paired TVs simply get a 409.
      if (!getDeviceSecret()) {
        void request<{ device_token: string }>("/api/auth/device/register", { method: "POST", body: "{}" })
          .then(r => setDeviceSecret(r.device_token))
          .catch(() => {});
      }
      return me;
    })
    .catch(e => {
      mePromise = null;
      throw e;
    });
  return mePromise;
}

export const resetSession = () => (mePromise = null);

/**
 * Where to land after launch or sign-in on a paired TV: "Who's watching?" when the account has
 * more than one profile, else straight Home (like streaming apps; the top bar's avatar still opens the
 * picker for adding profiles).
 */
export async function landingPath(): Promise<"/" | "/profiles"> {
  if (!getDeviceSecret()) return "/";
  try {
    const d = await api.deviceProfiles();
    return d.profiles.length > 1 ? "/profiles" : "/";
  } catch {
    return "/";
  }
}

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_path: string;
  expires_in: number;
  interval: number;
};

export type DevicePoll =
  | { status: "pending" }
  | { status: "approved"; token: string; device_token: string | null }
  | { status: "expired" };

async function pollDevice(deviceCode: string): Promise<DevicePoll> {
  const res = await fetch(absolute("/api/auth/device/poll"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (res.status === 202) return { status: "pending" };
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  return { status: "approved", token: body.token, device_token: body.device_token ?? null };
}

/**
 * Download speed to the server in kbps. Escalates the sample size until a download takes long
 * enough to time reliably (fast LANs finish in well under a second). Cached for 10 minutes.
 */
let lastSpeed: { kbps: number; at: number } | null = null;
export async function measureBandwidthKbps(): Promise<number> {
  if (lastSpeed && Date.now() - lastSpeed.at < 10 * 60_000) return lastSpeed.kbps;
  let kbps = 0;
  for (const bytes of [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
    const started = performance.now();
    const res = await fetch(absolute(`/api/speedtest?bytes=${bytes}`), {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`speed test failed (${res.status})`);
    await res.arrayBuffer();
    const secs = Math.max((performance.now() - started) / 1000, 0.001);
    kbps = (bytes * 8) / 1000 / secs;
    if (secs > 0.5) break;
  }
  lastSpeed = { kbps, at: Date.now() };
  return kbps;
}

export const api = {
  /** Pass this TV's credential to add a profile to an already-paired TV. */
  /** Sign this TV in with a username and password (no code). */
  /** The TV app served by Panda (`/tv/`) in a browser signed in to Panda: set up from that sign-in
   * (the browser's cookie rides along, same address). Fails when the browser isn't signed in. */
  deviceFromBrowser: (deviceToken?: string | null) =>
    request<{ token: string; device_token: string | null }>("/api/auth/device/from-browser", {
      method: "POST",
      body: JSON.stringify({ device_name: "Panda in a browser", device_token: deviceToken ?? undefined }),
      credentials: "same-origin",
    }),
  deviceLogin: (username: string, password: string, deviceName: string, deviceToken?: string | null) =>
    request<{ token: string; device_token: string | null }>("/api/auth/device/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        device_name: deviceName,
        device_token: deviceToken ?? undefined,
      }),
    }),
  startDeviceSignIn: (deviceName: string, deviceToken?: string | null) =>
    request<DeviceStart>("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify({ device_name: deviceName, device_token: deviceToken ?? undefined }),
    }),
  deviceProfiles: () =>
    request<{
      device: { id: number; name: string; account_id: number };
      profiles: DeviceProfile[];
      /** This TV belongs to an admin's account: Who's watching offers the Debug page. */
      admin: boolean;
    }>("/api/auth/device/profiles", {
      method: "POST",
      body: JSON.stringify({ device_token: getDeviceSecret() }),
    }),
  /** Add a profile to this TV's account (no password; up to the account's limit). */
  createDeviceProfile: (name: string) =>
    request<User>("/api/auth/device/profiles/new", {
      method: "POST",
      body: JSON.stringify({ device_token: getDeviceSecret(), name }),
    }),
  switchProfile: (userId: number, pin?: string) =>
    request<{ token: string }>("/api/auth/device/switch", {
      method: "POST",
      body: JSON.stringify({ device_token: getDeviceSecret(), user_id: userId, pin }),
    }),
  home: () => request<Home>("/api/home"),
  homeMore: () => request<HomeMore>("/api/home/more"),
  myList: () => request<MyListEntry[]>("/api/favorites"),
  setInMyList: (kind: MyListEntry["kind"], id: string, inList: boolean) =>
    request<void>("/api/favorites", {
      method: inList ? "PUT" : "DELETE",
      body: JSON.stringify({ kind, id }),
    }),
  titles: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return request<Title[]>(`/api/titles?${qs}`);
  },
  title: (id: string) => request<Title>(`/api/titles/${encodeURIComponent(id)}`),
  /** A person: about them, their titles in your library, and their other work. */
  /** What's set up on the server (requests per kind, TMDB, mail): only offer what works. */
  features: () =>
    request<{
      request_movies: boolean;
      request_shows: boolean;
      tmdb: boolean;
      mail: boolean;
      /** Bazarr is set up: subtitles can be searched for on request. */
      subtitle_search?: boolean;
    }>("/api/features"),
  /** The credits of the metadata providers in use (About). Public: works before a profile is picked. */
  credits: () => request<Credit[]>("/api/credits"),
  /** Get more seasons of a show you have (Sonarr monitors and searches them). */
  moreSeasons: (name: string, seasons: number[]) =>
    request<void>(`/api/series/${encodeURIComponent(name)}/seasons`, {
      method: "POST",
      body: JSON.stringify({ seasons }),
    }),
  /** Libraries whose storage (a NAS) is offline right now, by name. */
  offlineLibraries: () => request<string[]>("/api/libraries/offline"),
  person: (id: number) => request<PersonPage>(`/api/people/${id}`),
  /** A title you don't have, with cast, details and its request status. */
  preview: (kind: "movie" | "series", tmdbId: number) => request<Preview>(`/api/discover/${kind}/${tmdbId}`),
  /** Shows you don't have like this one, requestable (empty without TMDB + Sonarr). */
  seriesSuggestions: (name: string) =>
    request<Discover[]>(`/api/series/${encodeURIComponent(name)}/suggestions`),
  /** A show's cast, creators and facts (TMDB). */
  /** `season`: a season taken from another show (an anthology's story) gets that show's details. */
  seriesDetails: (name: string, season?: number) =>
    request<TitleDetails>(
      `/api/series/${encodeURIComponent(name)}/details${season === undefined ? "" : `?season=${season}`}`,
    ),
  /** Not-in-library titles like this one, requestable (empty without TMDB + Radarr). */
  titleSuggestions: (id: string) => request<Discover[]>(`/api/titles/${encodeURIComponent(id)}/suggestions`),
  /** The series of films a movie is part of (null: none). */
  titleCollection: (id: string) =>
    request<CollectionView | null>(`/api/titles/${encodeURIComponent(id)}/collection`),
  titleDetails: (id: string) => request<TitleDetails>(`/api/titles/${encodeURIComponent(id)}/details`),
  relatedTitles: (id: string) => request<Title[]>(`/api/titles/${encodeURIComponent(id)}/related`),
  playTitle: (id: string, profile: ClientProfile, startSecs = 0, version?: number, audioIndex?: number) =>
    request<Playback>(`/api/titles/${encodeURIComponent(id)}/playback`, {
      method: "POST",
      body: JSON.stringify({ profile, start_secs: startSecs, version, audio_index: audioIndex }),
    }),
  progress: (itemId: number, positionSecs: number, durationSecs?: number) =>
    request<Progress>("/api/progress", {
      method: "POST",
      body: JSON.stringify({ item_id: itemId, position_secs: positionSecs, duration_secs: durationSecs }),
    }),
  watched: (itemId: number, watched: boolean) =>
    request<void>("/api/watched", { method: "POST", body: JSON.stringify({ item_id: itemId, watched }) }),
  pollDevice,
  libraries: () => request<Library[]>("/api/libraries"),
  series: () => request<SeriesSummary[]>("/api/series"),
  relatedSeries: (name: string) =>
    request<SeriesSummary[]>(`/api/series/${encodeURIComponent(name)}/related`),
  items: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return request<Item[]>(`/api/items?${qs}`);
  },
  item: (id: number) => request<Item>(`/api/items/${id}`),
  startPlayback: (id: number, profile: ClientProfile, startSecs = 0, audioIndex?: number) =>
    request<Playback>(`/api/items/${id}/playback`, {
      method: "POST",
      body: JSON.stringify({ profile, start_secs: startSecs, audio_index: audioIndex }),
    }),
  /** Fire-and-forget; `keepalive` lets it complete even while the page is navigating away. */
  stopSession: (sessionId: string) =>
    fetch(absolute(`/api/hls/${sessionId}`), {
      method: "DELETE",
      keepalive: true,
      headers: authHeaders(),
    }).catch(() => {}),
  subtitles: (url: string) => request<string>(url),
  /** Ask Bazarr for subtitles in `language` (ISO 639-1) for this file; the tracks after. */
  findSubtitles: (itemId: number, language: string) =>
    request<{ found: boolean; subtitles: SubtitleTrack[] }>(`/api/items/${itemId}/subtitles/find`, {
      method: "POST",
      body: JSON.stringify({ language }),
      // Bazarr searches its providers meanwhile (the server waits up to 90 s).
      timeoutMs: 100_000,
    }),
  /** Change this profile's own name, language or avatar (`null` resets one). */
  updateProfile: (p: Partial<Pick<User, "display_name" | "language" | "avatar" | "preview_sound">>) =>
    request<User>("/api/auth/profile", { method: "PATCH", body: JSON.stringify(p) }).then(u => {
      applyProfile(u);
      return u;
    }),
  /**
   * Let this profile sign in on its own: a one-time link for `email` to choose a password,
   * emailed when the server has mail set up (`sent`), else returned to share.
   */
  signInLink: (email: string) =>
    request<{ path: string; email: string; sent: boolean }>("/api/auth/profile/sign-in-link", {
      method: "POST",
      body: JSON.stringify({ email, base_url: getServer() }),
    }),
  /** Turn this profile's own sign-in off (its other devices are signed out). */
  turnOffSignIn: () =>
    request<void>("/api/auth/profile/sign-in", { method: "DELETE" }).then(() => {
      resetSession();
      return ensureSession();
    }),
  /** Whether this profile has a PIN (never the PIN). */
  pinStatus: () => request<{ has_pin: boolean }>("/api/auth/pin"),
  /** Set, change or remove (`null`) this profile's PIN; an existing one needs `currentPin`. */
  setProfilePin: (pin: string | null, currentPin?: string) =>
    request<void>("/api/auth/profile/pin", {
      method: "PUT",
      body: JSON.stringify({ pin, current_pin: currentPin }),
    }),
  /**
   * Delete this profile (never the primary one; the server refuses). Its session dies with it,
   * so this TV forgets it and goes back to the profile picker.
   */
  deleteProfile: () =>
    request<void>("/api/auth/profile", { method: "DELETE" }).then(() => {
      setToken(null);
      setImageToken(null);
      setCurrentUser(null);
      resetSession();
    }),
  bitmapSubtitles: (url: string) => request<BitmapManifest>(url),
  /** Search the library (and TMDB for titles you don't have), or browse a genre. */
  /** `picks`: the empty screen's best-rated unwatched titles. */
  /** `more: false`: library only (findMore asks for the rest). */
  find: (q: { q?: string; genre?: string; picks?: boolean; more?: boolean }) => {
    const params = new URLSearchParams(
      Object.entries(q)
        .filter(([k, v]) => v || (k === "more" && v === false))
        .map(([k, v]) => [k, String(v)]),
    );
    return request<FindResults>(`/api/find?${params}`);
  },
  /** A preview clip's URL for the home hero / expanded cards; null while it's being made. */
  clip: (source: { kind: "title"; id: string } | { kind: "series"; name: string }) =>
    request<{ url: string | null }>(
      source.kind === "title"
        ? `/api/titles/${encodeURIComponent(source.id)}/clip`
        : `/api/series/${encodeURIComponent(source.name)}/clip`,
    ).then(r => ({ url: r.url ? absolute(r.url) : null })),
  /** Search's slow half: titles you don't have, from Radarr/Sonarr. */
  findMore: (q: string) => request<{ more: Discover[] }>(`/api/find/more?q=${encodeURIComponent(q)}`),
  /** People whose name matches (TMDB), as a title's cast is listed. */
  findPeople: (q: string) => request<Person[]>(`/api/find/people?q=${encodeURIComponent(q)}`),
  genres: () => request<string[]>("/api/genres"),
  genrePage: (name: string) => request<GenrePage>(`/api/genres/${encodeURIComponent(name)}`),
  /** The Movies or Shows page: every title of that kind, laid out like a genre page. */
  browsePage: (kind: "movies" | "shows") => request<GenrePage>(`/api/browse/${kind}`),
  /** One library's page (a top bar tab), laid out like Movies/Shows. */
  libraryPage: (id: string) => request<GenrePage>(`/api/browse/library/${encodeURIComponent(id)}`),
  /** Trending and "Popular on <service>" rows, minus what's in the library. */
  discover: () => request<DiscoverSet[]>("/api/discover"),
  /** Ask Radarr/Sonarr for a title found through search. */
  /** `seasons`: shows only, just these (omit for all). */
  /** Requests of this profile that arrived and haven't been looked at (for alerts). */
  notifications: () => request<Arrival[]>("/api/notifications"),
  request: (d: Discover, seasons?: number[] | null) =>
    request<unknown>("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        kind: d.kind,
        title: d.title,
        year: d.year,
        tmdb_id: d.tmdb_id,
        tvdb_id: d.tvdb_id,
        poster: d.poster,
        seasons: seasons ?? undefined,
      }),
    }),
  /** This profile's requests with each server's download progress. */
  myRequests: () => request<MyRequest[]>("/api/requests/mine"),
  cancelRequest: (id: number) => request<void>(`/api/requests/${id}`, { method: "DELETE" }),
};
