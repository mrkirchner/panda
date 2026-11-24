import type {
  BenchState,
  ActiveStreams,
  ArrProbe,
  ArrService,
  EpisodeOrders,
  FsListing,
  Invite,
  Item,
  Library,
  LibraryRow,
  MailSecurity,
  MatchCandidate,
  MatchKind,
  MatchSuspect,
  Me,
  MetadataOrder,
  ProviderId,
  Role,
  ScanStatus,
  SeasonRow,
  SeriesSummary,
  Session,
  Settings,
  SystemInfo,
  TvDevice,
  User,
} from "./types";

/** An error response from the Panda API. `message` is safe to show (the server never sends internals). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Same-origin JSON requests. The session lives in an HttpOnly cookie the page can't read;
 * the browser attaches it, and the server checks Origin on writes (CSRF).
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg =
      res.status === 429
        ? `Too many attempts. Try again in ${res.headers.get("retry-after") ?? "a few"} seconds.`
        : (body.error ?? `${res.status} ${res.statusText}`);
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  // session
  setupStatus: () => request<{ needs_setup: boolean }>("/api/setup"),
  setup: (token: string, username: string, password: string) =>
    send<{ user: User }>("POST", "/api/setup", { token, username, password }),
  login: (username: string, password: string) =>
    send<{ user: User }>("POST", "/api/auth/login", { username, password }),
  logout: () => send<void>("POST", "/api/auth/logout"),
  /** `null` when not signed in. */
  me: async (): Promise<Me | null> => {
    try {
      return await request<Me>("/api/auth/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  changePassword: (current_password: string, new_password: string) =>
    send<void>("POST", "/api/auth/password", { current_password, new_password }),
  pinStatus: () => request<{ has_pin: boolean }>("/api/auth/pin"),
  /** `pin` null removes it. */
  setPin: (current_password: string, pin: string | null) =>
    send<void>("PUT", "/api/auth/pin", { current_password, pin }),
  mySessions: () => request<Session[]>("/api/auth/sessions"),
  revokeMySession: (id: number) => send<void>("DELETE", `/api/auth/sessions/${id}`),
  approveDevice: (user_code: string) =>
    send<{ device_name: string }>("POST", "/api/auth/device/approve", { user_code }),
  inviteCheck: (code: string) => send<{ valid: boolean }>("POST", "/api/auth/invite/check", { code }),
  inviteAccept: (code: string, username: string, password: string) =>
    send<{ user: User }>("POST", "/api/auth/invite/accept", { code, username, password }),

  // library (any user)
  libraries: () => request<Library[]>("/api/libraries"),
  series: () => request<SeriesSummary[]>("/api/series"),
  items: (q = "") => request<Item[]>(`/api/items?limit=1000${q}`),

  // admin
  system: () => request<SystemInfo>("/api/admin/system"),
  streams: () => request<ActiveStreams>("/api/admin/streams"),
  settings: () => request<Settings>("/api/admin/settings"),
  saveTmdb: (read_access_token: string) =>
    send<void>("PUT", "/api/admin/settings/tmdb", { read_access_token }),
  removeTmdb: () => send<void>("DELETE", "/api/admin/settings/tmdb"),
  /** An extra metadata provider: its key (checked with it before saving), or on/off. */
  saveProvider: (id: ProviderId, body: { api_key: string } | { enabled: boolean }) =>
    send<void>("PUT", `/api/admin/settings/providers/${id}`, body),
  /** Remove its key, or turn it off (its stored answers are kept, unused). */
  removeProvider: (id: ProviderId) => send<void>("DELETE", `/api/admin/settings/providers/${id}`),
  /** Turn one thing a provider adds on or off (`option` from its `options`). */
  saveProviderSwitch: (provider: ProviderId, option: string, on: boolean) =>
    send<void>("PUT", "/api/admin/settings/provider-switch", { provider, option, on }),
  /** Returns the order as saved (repaired: missing providers added at the end). */
  saveMetadataOrder: (order: MetadataOrder) =>
    send<MetadataOrder>("PUT", "/api/admin/settings/metadata-order", order),
  /** Checked against the mail server before saving. Omit `password` to keep the saved one. */
  saveMail: (m: {
    host: string;
    port: number;
    security: MailSecurity;
    username: string;
    password?: string;
    from: string;
  }) => send<void>("PUT", "/api/admin/settings/mail", { ...m, password: m.password || undefined }),
  removeMail: () => send<void>("DELETE", "/api/admin/settings/mail"),
  /** Checked against Bazarr before saving. Omit `api_key` to keep the saved one. */
  saveBazarr: (url: string, api_key?: string) =>
    send<{ version: string }>("PUT", "/api/admin/settings/bazarr", { url, api_key: api_key || undefined }),
  removeBazarr: () => send<void>("DELETE", "/api/admin/settings/bazarr"),
  bench: () => request<BenchState>("/api/admin/bench"),
  /** Starts the stream capacity test in the background (refused while anyone is watching). */
  startBench: () => send<void>("POST", "/api/admin/bench"),
  /** Hardware re-encodes at once: applied now, kept over panda.toml's. */
  saveHardwareLimit: (max_hardware: number) =>
    send<void>("PUT", "/api/admin/settings/transcoding", { max_hardware }),
  storage: () =>
    request<{
      data_dir: string;
      cache_dir: string;
      cache_max_gb: number | null;
      cache_used_bytes: number;
      images_bytes: number;
    }>("/api/admin/settings/storage"),
  saveStorage: (cache_max_gb: number) => send<void>("PUT", "/api/admin/settings/storage", { cache_max_gb }),
  saveCleanup: (c: { movies: boolean; shows: boolean }) =>
    send<void>("PUT", "/api/admin/settings/cleanup", c),
  runCleanup: () => send<{ removed: number }>("POST", "/api/admin/settings/cleanup/run"),
  testMail: (to: string) => send<void>("POST", "/api/admin/settings/mail/test", { to }),
  /** A one-time link for a profile to set its own password (emailed when mail is set up). */
  signInLink: (userId: number, email: string) =>
    send<{ path: string; email: string; sent: boolean }>("POST", `/api/admin/users/${userId}/sign-in-link`, {
      email,
      base_url: location.origin,
    }),
  signInLinkCheck: (code: string) =>
    send<{ valid: boolean; name?: string; email?: string }>("POST", "/api/auth/sign-in-link/check", { code }),
  signInLinkUse: (code: string, password: string) =>
    send<void>("POST", "/api/auth/sign-in-link/use", { code, password }),
  probeArr: (service: ArrService, url: string, api_key?: string) =>
    send<ArrProbe>("POST", `/api/admin/settings/${service}/probe`, { url, api_key: api_key || undefined }),
  saveArr: (
    service: ArrService,
    body: { url: string; api_key?: string; quality_profile_id: number; root_folder: string },
  ) => send<void>("PUT", `/api/admin/settings/${service}`, { ...body, api_key: body.api_key || undefined }),
  removeArr: (service: ArrService) => send<void>("DELETE", `/api/admin/settings/${service}`),
  users: () => request<User[]>("/api/admin/users"),
  updateUser: (
    id: number,
    patch: { role?: Role; disabled?: boolean; libraries?: number[]; age_limit?: { max_age: number | null } },
  ) => send<void>("PATCH", `/api/admin/users/${id}`, patch),
  deleteUser: (id: number) => send<void>("DELETE", `/api/admin/users/${id}`),
  resetPassword: (id: number, new_password: string) =>
    send<void>("POST", `/api/admin/users/${id}/password`, { new_password }),
  invites: () => request<Invite[]>("/api/admin/invites"),
  setUserPin: (id: number, pin: string | null) => send<void>("PUT", `/api/admin/users/${id}/pin`, { pin }),
  /** An invite creates a new account, owned by the person who accepts it. */
  /** Libraries whose storage (a NAS) is offline right now, by name. */
  offlineLibraries: () => request<string[]>("/api/libraries/offline"),
  /** What's set up (requests per kind, TMDB, mail): screens only offer what works. */
  features: () =>
    request<{ request_movies: boolean; request_shows: boolean; tmdb: boolean; mail: boolean }>(
      "/api/features",
    ),
  /** Emailed too when `email` is given (needs mail set up in Settings). */
  createInvite: (role: Role, note: string, expires_days: number, email?: string) =>
    send<{ invite: Invite; code: string; path: string; sent: boolean }>("POST", "/api/admin/invites", {
      role,
      note,
      expires_days,
      email: email || undefined,
      base_url: location.origin,
    }),
  deleteInvite: (id: number) => send<void>("DELETE", `/api/admin/invites/${id}`),
  sessions: () => request<Session[]>("/api/admin/sessions"),
  tvs: () => request<TvDevice[]>("/api/admin/devices"),
  // matches (fixing wrong TMDB matches)
  matchSuspects: () => request<MatchSuspect[]>("/api/admin/matches"),
  searchMatches: (kind: MatchKind, q: string) =>
    request<MatchCandidate[]>(`/api/admin/matches/search?kind=${kind}&q=${encodeURIComponent(q)}`),
  applyMatch: (kind: MatchKind, id: string, tmdb_id: number) =>
    send<void>("POST", "/api/admin/matches", { kind, id, tmdb_id }),
  matchSeasons: (series: string) =>
    request<SeasonRow[]>(`/api/admin/matches/seasons?series=${encodeURIComponent(series)}`),
  applySeasonMatch: (series: string, season: number, tmdb_id: number, tmdb_season: number) =>
    send<void>("POST", "/api/admin/matches/season", { series, season, tmdb_id, tmdb_season }),
  episodeOrders: (series: string) =>
    request<EpisodeOrders>(`/api/admin/matches/episode-order?series=${encodeURIComponent(series)}`),
  /** Number a show by another of TMDB's episode orders, or `null` for its default seasons. */
  setEpisodeOrder: (series: string, id: string | null) =>
    send<void>("PUT", "/api/admin/matches/episode-order", { series, id }),
  clearSeasonMatch: (series: string, season: number) =>
    send<void>("DELETE", `/api/admin/matches/season?series=${encodeURIComponent(series)}&season=${season}`),
  forgetTv: (id: number) => send<void>("DELETE", `/api/admin/devices/${id}`),
  revokeSession: (id: number) => send<void>("DELETE", `/api/admin/sessions/${id}`),
  adminLibraries: () => request<LibraryRow[]>("/api/admin/libraries"),
  renameLibrary: (id: number, name: string) => send<void>("PATCH", `/api/admin/libraries/${id}`, { name }),
  addFolder: (id: number, path: string) => send<void>("POST", `/api/admin/libraries/${id}/folders`, { path }),
  removeFolder: (id: number, path: string) =>
    send<void>("DELETE", `/api/admin/libraries/${id}/folders`, { path }),
  mergeLibrary: (into: number, from: number) =>
    send<void>("POST", `/api/admin/libraries/${into}/merge`, { from }),
  scanStatus: () => request<ScanStatus>("/api/admin/libraries/scan"),
  addLibrary: (name: string, kind: Library["kind"], path: string) =>
    send<Library>("POST", "/api/admin/libraries", { name, kind, path }),
  removeLibrary: (id: number) => send<void>("DELETE", `/api/admin/libraries/${id}`),
  scan: () => send<void>("POST", "/api/admin/libraries/scan"),
  browse: (path?: string) =>
    request<FsListing>(`/api/admin/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
};

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
