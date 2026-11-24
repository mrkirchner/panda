// Mirrors the Rust server's JSON. Keep in sync with crates/panda-server/src/routes.

export type ItemKind = "movie" | "episode";

export interface Item {
  id: number;
  library_id: number;
  kind: ItemKind;
  title: string;
  year: number | null;
  series: string | null;
  season: number | null;
  episode: number | null;
  size_bytes: number;
  duration_secs: number | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  dynamic_range: "sdr" | "hdr10" | "hlg" | "dolbyvision" | null;
  added_at: string;
  // TMDB metadata (null until matched). Image fields are keys for `/api/images/{key}`.
  tmdb_id: number | null;
  meta_title: string | null;
  overview: string | null;
  genres: string | null;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
  episode_title: string | null;
  episode_overview: string | null;
  /** The episode's own still (image key); else use the show's backdrop. */
  episode_still?: string | null;
  progress?: Progress | null;
}

export interface Progress {
  position_secs: number;
  duration_secs: number | null;
  finished: boolean;
  /** 0-1 for progress bars. */
  fraction: number;
  last_played_at: number;
}

export interface Version {
  item_id: number;
  /** "4K Dolby Vision", "1080p" */
  label: string;
  width: number | null;
  height: number | null;
  dynamic_range: string | null;
  video_codec: string | null;
  size_bytes: number;
}

/** A movie, possibly with several files (versions). */
export interface Title {
  id: string;
  kind: "movie";
  library_id: number;
  title: string;
  year: number | null;
  overview: string | null;
  genres: string | null;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
  duration_secs: number | null;
  added_at: string;
  versions: Version[];
  progress: Progress | null;
}

/** Someone in a title's cast or crew. */
export interface Person {
  /** TMDB person id: their page. */
  id: number | null;
  name: string;
  /** Character played, or the job ("Director"). */
  role: string | null;
  /** Headshot image key. */
  image: string | null;
}

/** A rating on a title's details: TMDB's, then OMDb's. */
export interface TitleRating {
  /** "tmdb", "imdb", "rotten_tomatoes", "metacritic". */
  source: string;
  /** "Rotten Tomatoes", and "RT" where space is short. */
  label: string;
  short: string;
  /** As the source writes it: "7.8/10", "8.3/10", "91%", "74/100". */
  value: string;
}

/** A title's details page (from TMDB; empty when unmatched or TMDB isn't set up). */
export interface TitleDetails {
  /** TMDB's, then OMDb's when it's set up (library titles only). */
  ratings?: TitleRating[];
  /** Its logo (image key), when it has one. */
  logo?: string | null;
  /** Movies: the series of films it's part of (`/api/titles/{id}/collection`). */
  collection?: { id: number; name: string } | null;
  /** Where it was made. */
  countries?: string[];
  /** Shows: "Returning Series", "Ended", ... */
  status?: string | null;
  /** Shows: the next episode to air, with its date. */
  next_episode?: {
    season: number;
    episode: number;
    name: string | null;
    overview: string | null;
    air_date: string | null;
  } | null;
  /** Your copy's languages: ISO 639 code and kind ("5.1", "Forced"). */
  audio?: TrackInfo[];
  subtitles?: TrackInfo[];
  /** Several versions with different languages: each one's ("4K Dolby Vision", "1080p"). */
  version_languages?: { label: string; audio: TrackInfo[]; subtitles: TrackInfo[] }[];
  /** Shows: how many seasons there are (TMDB). */
  seasons?: number | null;
  tagline: string | null;
  /** "2024-03-01" */
  release_date: string | null;
  /** Age rating in the server's region ("PG-13"). */
  certification: string | null;
  runtime_mins: number | null;
  /** ISO 639-1 ("en"). */
  original_language: string | null;
  studios: string[];
  directors: Person[];
  writers: string[];
  cast: Person[];
  /** Shows: seasons taken from another TMDB show (an anthology's stories), with its artwork. */
  season_art?: SeasonArt[];
}

export interface SeasonArt {
  season: number;
  /** That show's name ("Monster: The Ed Gein Story"). */
  title: string;
  poster: string | null;
  backdrop: string | null;
  /** That show's description and first year. */
  overview: string | null;
  year: number | null;
}

/** A person's page: about them, their titles in your library, and more to request. */
export interface PersonPage {
  name: string;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  /** "Acting", "Directing"... */
  known_for: string | null;
  image: string | null;
  /** The page's backdrop: one of theirs in your library, else their best-known title's. */
  backdrop: string | null;
  movies: Title[];
  shows: SeriesSummary[];
  /** Their other work by role ("Movies", "Directed"... English), their main one first. */
  roles: { role: string; items: Discover[] }[];
}

/** A title you don't have, as a full page (TMDB details plus request status). */
export interface Preview extends Discover {
  backdrop: string | null;
  genres: string | null;
  runtime_mins: number | null;
  seasons: number | null;
  details: TitleDetails;
  /** In your library after all: the title id or show name to open instead. */
  library: string | null;
  /** Movies: the series of films it's part of. */
  collection?: CollectionView | null;
  /** TMDB's recommendations not in the library. */
  more?: Discover[];
}

export interface ContinueEntry {
  kind: "movie" | "episode";
  item_id: number;
  title_id: string | null;
  series: string | null;
  title: string;
  subtitle: string;
  poster: string | null;
  backdrop: string | null;
  position_secs: number;
  duration_secs: number | null;
  fraction: number;
  up_next: boolean;
  last_played_at: number;
}

export interface MyListEntry {
  kind: "title" | "series";
  /** Title id or series name. */
  id: string;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
}

/** What to play for a featured show (in progress, else first unwatched). */
export interface NextEpisode {
  item_id: number;
  season: number;
  episode: number;
  position_secs: number;
}

/** A home hero slide: exactly one of `movie` / `series` is set. */
export interface Featured {
  /** Why it's featured, shown above the title. */
  reason: "Recently added" | "New release" | "Top rated" | "From your library";
  movie?: Title;
  series?: SeriesSummary & { next: NextEpisode | null };
  /** Its logo (image key), when one is known. */
  logo?: string | null;
  /** Its ratings, TMDB's first. */
  ratings?: TitleRating[];
}

export interface Home {
  /** Plain movies from servers older than the mixed hero (see Home's asFeatured). */
  featured: (Featured | Title)[];
  continue_watching: ContinueEntry[];
  my_list: MyListEntry[];
  /** Requests of this profile that arrived lately ("Ready to watch"), until their page is opened
   * (servers before it: missing). */
  ready?: MyListEntry[];
  recently_added_movies: Title[];
  recently_added_shows: SeriesSummary[];
}

/** A request of this profile whose title arrived (`/api/notifications`). */
export interface Arrival {
  /** The request's id. */
  id: number;
  kind: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  ready_at: number | null;
  /** What opens it: a movie's title id, or a show's name. */
  title_id: string | null;
  series: string | null;
}

export interface DeviceProfile {
  user_id: number;
  username: string;
  has_pin: boolean;
  display_name: string | null;
  avatar: string | null;
}

export interface Library {
  id: number;
  name: string;
  kind: "movies" | "shows";
}

export interface SeriesSummary {
  series: string;
  library_id: number;
  episodes: number;
  seasons: number;
  tmdb_id: number | null;
  meta_title: string | null;
  year: number | null;
  overview: string | null;
  genres: string | null;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
  latest_added_at?: string;
}

export interface ClientProfile {
  containers: string[];
  video_codecs: string[];
  audio_codecs: string[];
  max_height: number;
  supports_hdr: boolean;
  supports_dolby_vision: boolean;
  max_audio_channels: number;
  /** Total stream budget; omitted = no limit. */
  max_bitrate_kbps?: number;
}

export interface SubtitleTrack {
  /** Stream index in the file; for a subtitle file, its place among the files. */
  index: number;
  /** Stable per track of a file: `s<index>` (in the file) or `f<id>` (a subtitle file). */
  key: string;
  language: string | null;
  codec: string;
  default: boolean;
  forced: boolean;
  /** For the deaf and hard of hearing (SDH). */
  hearing_impaired: boolean;
  /** A subtitle file next to the video (`Movie.en.srt`, e.g. from Bazarr). */
  external: boolean;
  /** A subtitle file of another version of the movie ("4K Dolby Vision"). */
  from_version?: string;
  /** Its title in the file ("Forced French subtitles"). */
  title?: string;
  /** `text`: `url` is WebVTT. `bitmap`: `url` is an image manifest (PGS), or null if unsupported. */
  overlay: "text" | "bitmap";
  url: string | null;
}

/** What the viewer is actually getting. */
export interface StreamSummary {
  mode: "direct" | "remux" | "transcode";
  codec: string;
  height: number;
  bitrate_kbps: number | null;
  pipeline: string | null;
}

/** An audio track the player can switch to (`audio_index` in the playback request). */
export interface AudioTrack {
  index: number;
  language: string | null;
  codec: string;
  channels: number;
  default: boolean;
  /** Its title in the file ("Director's commentary"). */
  title?: string;
}

/** Parental controls: the account's other profiles and their age limits (`max_age`: the oldest
 * rating they may watch, null = none). */
export interface AgeLimits {
  has_parental_pin: boolean;
  /** The limits offered, as ages (0 = all ages). */
  limits: number[];
  profiles: { user_id: number; name: string; avatar: string | null; max_age: number | null }[];
}

/** "All ages", "13+", "No limit". */
export function ageLimitLabel(maxAge: number | null, t: (s: string) => string): string {
  if (maxAge === null) return t("No limit");
  return maxAge === 0 ? t("All ages") : `${maxAge}+`;
}

/** Where an episode's intro and credits are (file time, seconds), for Skip intro and Up next.
 * `pending`: the server is still listening for them; ask again later (`api.markers`). */
export interface Markers {
  intro_start?: number | null;
  intro_end?: number | null;
  credits_start?: number | null;
  pending?: boolean;
}

/** The episode after the one playing. */
export interface NextUp {
  item_id: number;
  series: string;
  season: number;
  episode: number;
  title?: string | null;
  /** The episode's still and the show's backdrop (image keys). */
  still?: string | null;
  backdrop?: string | null;
}

interface PlaybackSkips {
  markers?: Markers;
  next?: NextUp | null;
}

export type Playback = PlaybackSkips &
  (
  | {
      method: "direct_play";
      item_id: number;
      url: string;
      mime_type: string;
      stream: StreamSummary;
      subtitles: SubtitleTrack[];
      /** The file's audio tracks, and the one playing. */
      audio?: AudioTrack[];
      audio_index?: number | null;
      /** Scrub preview of any moment: replace `{secs}` with the time. Absent without video. */
      preview_url?: string | null;
    }
  | {
      method: "hls";
      item_id: number;
      url: string;
      session_id: string;
      /** HLS timeline starts at 0; add this to get the position in the file. */
      start_secs: number;
      reasons: string[];
      stream: StreamSummary;
      subtitles: SubtitleTrack[];
      /** The file's audio tracks, and the one playing. */
      audio?: AudioTrack[];
      audio_index?: number | null;
      preview_url?: string | null;
    }
  );

export interface User {
  id: number;
  username: string;
  role: "admin" | "user";
  /** The account it belongs to: its owner's id (equal to `id` for the owner, the primary). */
  account_id: number;
  /** Shown instead of the username when set. */
  display_name: string | null;
  /** No password of its own (made on a TV): can't sign in until given a sign-in. */
  managed: boolean;
  /** Its own sign-in email, once set up. */
  email: string | null;
  /** "en" | "es"; null follows the device. */
  language: string | null;
  /** Avatar picture id (images/avatars/<id>.svg); null is the colored initial. */
  avatar: string | null;
  /** Home preview clips play (quietly) with sound. */
  preview_sound: boolean;
}

export interface Me {
  user: User;
  session_id: number;
  image_token: string;
}

/** A TMDB title that isn't in the library (search's "not in your library" row). */
export interface Discover {
  kind: "movie" | "series";
  tmdb_id: number;
  /** Shows: what Sonarr adds by. */
  tvdb_id: number | null;
  title: string;
  year: number | null;
  overview: string | null;
  rating: number | null;
  /** Artwork key (like library posters). */
  poster: string | null;
  /** You asked for it, or the server already has it (on its way). */
  requested: boolean;
  /** The server has the file; the library just hasn't picked it up yet. */
  downloaded: boolean;
  /** Not on the server yet, so it can be requested. */
  can_request: boolean;
}

/** One Radarr/Sonarr server's view of a request (`progress` null: no answer / not there). */
export interface TierProgress {
  tier: "hd" | "4k";
  progress: {
    state: "searching" | "downloading" | "importing" | "available";
    /** 0-1. */
    fraction: number;
    eta: string | null;
  } | null;
}

/** A request of this profile, with live progress (My List). */
export interface MyRequest {
  id: number;
  kind: "movie" | "series";
  title: string;
  year: number | null;
  tmdb_id: number | null;
  poster: string | null;
  status: "pending" | "approved" | "available" | "failed";
  error: string | null;
  tiers: TierProgress[];
  /** In the library: open `/title/<title_id>` or `/series/<series>`. */
  title_id: string | null;
  series: string | null;
  /** Arrived and already added to My List: it shows as a saved title, not a request. */
  listed: boolean;
}

/** A row of popular titles you don't have (Search's empty screen). */
export interface DiscoverSet {
  title: string;
  items: Discover[];
}

export interface FindResults {
  movies: Title[];
  shows: SeriesSummary[];
  more: Discover[];
}

/** The rest of Home (`/api/home/more`): genre tiles, feature cards and themed rows. */
export interface HomeMore {
  genres: GenreTile[];
  /** Wide banners between rows. */
  spotlights: Spot[];
  /** Tall cards: "Top picks for you". */
  top_picks: Spot[];
  /** Holidays in season, then the day's themes ("Heists"). */
  themed: ThemedRow[];
}

export interface GenreTile {
  name: string;
  /** The page it opens (filtered to the genre). */
  kind: "movies" | "shows";
  backdrop: string;
  count: number;
}

/** A featured movie (`id`: its title id) or show (`id`: its name), with why it's featured. */
export interface Spot {
  kind: "movie" | "series";
  id: string;
  title: string;
  year: number | null;
  genres: string | null;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
  /** The title's logo (its name as transparent artwork), when TMDB has one. */
  logo: string | null;
  /** English, for `t()`: "Top rated", "Because you watched {title}"... */
  reason: string;
  reason_title: string | null;
}

/** A genre's page (`/api/genres/{name}`): from the library, movies and shows together. */
export interface GenrePage {
  name: string;
  backdrop: string | null;
  /** Which list "See all" opens. */
  kind: "movies" | "shows";
  /** How many titles have it. */
  count: number;
  featured: Spot[];
  /** Best rated first (the top ten). */
  top: Spot[];
  recent: Spot[];
  /** The genres most often paired with this one, each with its titles. */
  paired: { genre: string; items: Spot[] }[];
}

export interface ThemedRow {
  /** English, for `t()`: "Christmas", "Heists"... */
  title: string;
  seasonal: boolean;
  /** In the library. */
  items: Spot[];
  /** Popular ones you don't have, after them: requestable (or already on their way). */
  more: Discover[];
}

/** A metadata provider's credit, as its terms ask (the About page). */
export interface Credit {
  /** "tmdb", "tvmaze", "omdb". */
  id: string;
  name: string;
  /** "This product uses the TMDB API but is not endorsed or certified by TMDB." */
  credit: string;
  site: string;
}

/** One language of a file. */
export interface TrackInfo {
  language: string | null;
  detail: string | null;
}

/** A movie's series of films, oldest first: yours open, the others can be requested. */
export interface CollectionView {
  name: string;
  items: { title?: Title; suggestion?: Discover }[];
}
