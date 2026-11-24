// Mirrors the Panda server's JSON (crates/panda-server/src/routes, crates/panda-db).

export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: number;
  last_login_at: number | null;
  /** The account this profile belongs to: its owner's id (the owner's own id for the owner). */
  account_id: number;
  /** Profile without a password (made on a TV or here): TV-only, can't sign in. */
  managed: boolean;
  /** Shown instead of the username when set. */
  display_name: string | null;
  /** Signs in with this (or the username) once it has its own sign-in. */
  email: string | null;
  /** The oldest age rating this profile may watch; null = no limit. */
  max_age?: number | null;
  /** Admin list only: libraries this user may see; null = all. */
  libraries?: number[] | null;
}

export interface Me {
  user: User;
  session_id: number;
  image_token: string;
}

export interface Session {
  id: number;
  user_id: number;
  kind: "browser" | "device";
  name: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface Invite {
  id: number;
  role: Role;
  note: string | null;
  created_by: number | null;
  created_at: number;
  expires_at: number;
  used_by: number | null;
  used_at: number | null;
}

export interface Library {
  id: number;
  name: string;
  kind: "movies" | "shows";
  /** Folders on the server whose files belong to this library. */
  folders: string[];
}

/** Admin view of a library. */
export interface LibraryRow extends Library {
  items: number;
  unmatched: number;
}

export interface TvDevice {
  /** `account_id`: the account that paired it; it lists that account's profiles. */
  device: { id: number; name: string; created_at: number; last_seen_at: number; account_id: number };
  profiles: { user_id: number; username: string; display_name: string | null; has_pin: boolean }[];
}

export interface ScanStatus {
  scanning: boolean;
  last_scan_at: number | null;
  /** null = periodic scans off. */
  interval_minutes: number | null;
}

export interface SeriesSummary {
  series: string;
  library_id: number;
  episodes: number;
}

export interface Item {
  id: number;
  library_id: number;
  kind: "movie" | "episode";
  title: string;
  tmdb_id: number | null;
}

export interface ArrSettings {
  url: string;
  api_key_set: boolean;
  quality_profile_id: number;
  root_folder: string;
}

export interface Settings {
  tmdb: { configured: boolean; source: "env" | "settings" | null };
  /** Which provider's answer is shown, per kind of data, best first. */
  metadata_order: MetadataOrder;
  /** The kinds of data in `metadata_order`, with their labels. */
  metadata_fields: { id: MetadataField; label: string }[];
  /** TMDB, TVmaze (episode gaps, no key), OMDb (ratings, admin's key): on or off, and switches. */
  providers: MetadataProvider[];
  radarr: ArrSettings | null;
  /** Optional second Radarr/Sonarr for 4K copies. Requests go to every configured server. */
  radarr_4k: ArrSettings | null;
  sonarr: ArrSettings | null;
  sonarr_4k: ArrSettings | null;
  /** Outgoing mail (sign-in links); the password only as "is it set". */
  mail: MailSettings | null;
  /** Weekly removal of finished titles from Radarr/Sonarr (files kept). */
  cleanup: { movies: boolean; shows: boolean };
  /** Bazarr, for finding subtitles on request; the key only as "is it set". */
  bazarr: { url: string; api_key_set: boolean } | null;
}

/** The stream capacity test (`panda bench`) as the admin UI shows it. */
export interface BenchState {
  progress: { running: boolean; lines: string[]; error: string | null };
  report: {
    ran_at: number;
    seconds: number;
    ffmpeg: { version: string; hardware: string[]; encoders: string[]; tonemap: string[] };
    kinds: {
      name: string;
      how: string;
      file: string;
      rounds: (number | null)[];
      best: number;
      max: number;
      hardware_encode: boolean;
    }[];
  } | null;
  suggested_hardware_limit: number | null;
  hardware_limit: number;
  min_speed: number;
}

export type ProviderId = "tmdb" | "tvmaze" | "omdb" | "fanart";
export type MetadataField = "overview" | "episodes" | "posters" | "backdrops" | "logos";
export type MetadataOrder = Record<MetadataField, ProviderId[]>;

export interface MetadataProvider {
  id: ProviderId;
  name: string;
  /** TMDB: the base, set up with its own card. The others add to it. */
  base: boolean;
  /** What it adds (for its card). */
  about: string;
  /** The credit its terms ask for, and where it links. */
  credit: string;
  site: string;
  /** Set: it needs the admin's own key (how to get one). Null: just switched on or off. */
  key_hint: string | null;
  enabled: boolean;
  /** Why it can't be set up yet ("Set up TMDB first"); the server refuses until then. */
  blocked_by: string | null;
  /** What the admin can switch off for it (OMDb's Rotten Tomatoes score, ...). */
  options: { id: string; label: string; on: boolean }[];
}

export type MailSecurity = "tls" | "starttls" | "none";

export interface MailSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  password_set: boolean;
  from: string;
}

/** A Radarr/Sonarr settings slot. */
export type ArrService = "radarr" | "radarr_4k" | "sonarr" | "sonarr_4k";

export interface ArrProbe {
  version: string;
  quality_profiles: { id: number; name: string }[];
  root_folders: { id: number; path: string; free_space: number | null }[];
}

export interface SystemInfo {
  version: string;
  ffmpeg: {
    path: string;
    flavor: "jellyfin" | "stock";
    version: string;
    hwaccels: string[];
    tonemap: string[];
  };
  tmdb: boolean;
  radarr: boolean;
  radarr_4k: boolean;
  sonarr: boolean;
  sonarr_4k: boolean;
  libraries: { id: number; name: string; kind: "movies" | "shows"; items: number; unmatched: number }[];
}

export interface FsListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export interface ActiveStreams {
  limits: { hardware: number; software: number };
  in_use: { remux: number; hardware: number; software: number };
  streams: {
    title: string | null;
    user: string | null;
    stream: {
      id: string;
      slot: "remux" | "hardware" | "software";
      pipeline: string;
      output: string;
      started_at: number;
      idle_secs: number;
      item_id: number;
    };
  }[];
}

/** Fixing TMDB matches (admin). */
export type MatchKind = "movie" | "series";

export interface MatchSuspect {
  kind: MatchKind;
  /** A title id (`m603`, `i42`) or a show's name: what to send back to fix it. */
  id: string;
  /** The file or folder name Panda matched from. */
  name: string;
  year: number | null;
  /** null: not matched at all. */
  matched: { tmdb_id: number; title: string; year: number | null; poster: string | null } | null;
  reason: "not matched" | "different title" | "different year";
}

export interface MatchCandidate {
  tmdb_id: number;
  title: string;
  year: string | null;
  overview: string | null;
  poster: string | null;
}

/** A season of a show folder; `matched` when taken from another TMDB show by hand. */
export interface SeasonRow {
  season: number;
  episodes: number;
  /** With an episode order chosen: the name of its part numbered as this season. */
  order_part: string | null;
  matched: {
    tmdb_id: number;
    tmdb_season: number;
    title: string;
    poster: string | null;
  } | null;
}

/** A show folder's episode order: the chosen one (null: TMDB's default seasons) and the others
 * TMDB has for the show (DVD, absolute, ...). */
export interface EpisodeOrders {
  /** The chosen order's id (null: TMDB's default seasons). */
  current: string | null;
  orders: { id: string; name: string; kind: string; episodes: number; seasons: number }[];
}
