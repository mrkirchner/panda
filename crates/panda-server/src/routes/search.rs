//! TV search: your library first (movies and shows), then titles you don't have yet from
//! Radarr's/Sonarr's own search, which can be requested. Also genre browsing for the empty state.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use futures_util::future::join_all;
use panda_db::{RequestKind, SeriesSummary};
use panda_metadata::ImageSize;
use panda_metadata::matching::normalize;
use serde::{Deserialize, Serialize};

use super::titles::{Title, movie_titles};
use crate::auth::{CurrentUser, access};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Library matches per kind.
const LIBRARY_LIMIT: usize = 40;
/// Top picks per kind on the empty search screen.
const PICKS_LIMIT: usize = 20;
/// Titles you don't have.
const MORE_LIMIT: usize = 12;
/// Shorter queries only search the library (TMDB matches on one letter are noise).
const TMDB_MIN_CHARS: usize = 2;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/find", get(find))
        .route("/find/more", get(find_more))
        .route("/find/people", get(find_people))
        .route("/genres", get(genres))
        .route("/discover", get(discover_sets))
        .route("/titles/{id}/suggestions", get(title_suggestions))
        .route("/titles/{id}/collection", get(title_collection))
        .route("/series/{name}/suggestions", get(series_suggestions))
        .route("/discover/{kind}/{tmdb_id}", get(preview))
        .route("/people/{id}", get(person))
}

#[derive(Deserialize)]
struct FindQuery {
    q: Option<String>,
    /// Browse a genre instead of searching (library only).
    genre: Option<String>,
    /// Search's empty screen: best-rated movies you haven't finished, and best-rated shows.
    #[serde(default)]
    picks: bool,
    /// Include "not in your library" results (Radarr/Sonarr lookups, which can take seconds).
    /// The TV asks for library results with `more=false`, then `/find/more` separately.
    #[serde(default = "yes")]
    more: bool,
}

const fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct MoreQuery {
    q: String,
}

#[derive(Serialize)]
struct MoreResults {
    more: Vec<Discover>,
}

/// A title from Radarr/Sonarr search that isn't in the library.
#[derive(Debug, Clone, Serialize)]
pub(super) struct Discover {
    pub(super) kind: RequestKind,
    pub(super) tmdb_id: i64,
    /// Shows: what Sonarr adds by (so requesting needs no TMDB lookup).
    tvdb_id: Option<i64>,
    title: String,
    year: Option<i64>,
    overview: Option<String>,
    rating: Option<f64>,
    /// Cached artwork key (served by `/api/images`), when TMDB has a poster.
    pub(super) poster: Option<String>,
    /// You asked for it, or the server already has it (on its way).
    pub(super) requested: bool,
    /// The server has the file; the library just hasn't picked it up yet.
    pub(super) downloaded: bool,
    /// Not on the server yet, so it can be requested.
    pub(super) can_request: bool,
}

#[derive(Debug, Serialize)]
struct FindResults {
    movies: Vec<Title>,
    shows: Vec<SeriesSummary>,
    more: Vec<Discover>,
}

/// How well `title` matches `query` (both normalized): lower is better, `None` is no match.
/// Exact, then starts with, then a word starts with, then anywhere.
fn match_rank(query: &str, title: &str) -> Option<u8> {
    if query.is_empty() {
        return None;
    }
    if title == query {
        Some(0)
    } else if title.starts_with(query) {
        Some(1)
    } else if title.contains(&format!(" {query}")) {
        Some(2)
    } else if title.contains(query) {
        Some(3)
    } else {
        None
    }
}

/// Best match rank over a title's names.
fn best_rank(query: &str, names: &[&str]) -> Option<u8> {
    names.iter().filter_map(|n| match_rank(query, &normalize(n))).min()
}

/// Sort by match rank, then rating (best first), and keep `limit`.
fn ranked<T>(mut hits: Vec<(u8, Option<f64>, T)>, limit: usize) -> Vec<T> {
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.unwrap_or(0.0).total_cmp(&a.1.unwrap_or(0.0))));
    hits.into_iter().take(limit).map(|(_, _, t)| t).collect()
}

fn has_genre(genres: Option<&str>, genre: &str) -> bool {
    genres.is_some_and(|g| g.split(',').any(|x| x.trim().eq_ignore_ascii_case(genre)))
}

async fn library_shows(state: &AppState, user_id: i64) -> ApiResult<Vec<SeriesSummary>> {
    let access = access(state, user_id).await?;
    crate::catalog::series(state, &access).await
}

async fn find(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Query(params): Query<FindQuery>,
) -> ApiResult<Json<FindResults>> {
    let movies = movie_titles(&state, me.user.id, None).await?;
    let shows = library_shows(&state, me.user.id).await?;

    if params.picks {
        let unfinished = |t: &Title| !t.progress.as_ref().is_some_and(|p| p.finished);
        let movies = movies.into_iter().filter(unfinished).map(|t| (0u8, t.rating, t)).collect();
        let shows = shows.into_iter().map(|s| (0u8, s.rating, s)).collect();
        return Ok(Json(FindResults {
            movies: ranked(movies, PICKS_LIMIT),
            shows: ranked(shows, PICKS_LIMIT),
            more: Vec::new(),
        }));
    }

    // Genre browsing: everything in that genre, best rated first.
    if let Some(genre) = params.genre.as_deref().filter(|g| !g.trim().is_empty()) {
        let pick = |g: Option<&str>, rating: Option<f64>| has_genre(g, genre).then_some((0u8, rating));
        let movies =
            movies.into_iter().filter_map(|t| pick(t.genres.as_deref(), t.rating).map(|(r, s)| (r, s, t)));
        let shows =
            shows.into_iter().filter_map(|s| pick(s.genres.as_deref(), s.rating).map(|(r, x)| (r, x, s)));
        return Ok(Json(FindResults {
            movies: ranked(movies.collect(), LIBRARY_LIMIT),
            shows: ranked(shows.collect(), LIBRARY_LIMIT),
            more: Vec::new(),
        }));
    }

    let query = normalize(params.q.as_deref().unwrap_or_default());
    if query.is_empty() {
        return Ok(Json(FindResults { movies: Vec::new(), shows: Vec::new(), more: Vec::new() }));
    }
    let have_movies: HashSet<String> = movies.iter().map(|t| t.id.clone()).collect();
    let have_shows: HashSet<i64> = shows.iter().filter_map(|s| s.tmdb_id).collect();
    let movie_hits =
        movies.into_iter().filter_map(|t| best_rank(&query, &[&t.title]).map(|r| (r, t.rating, t))).collect();
    let show_hits = shows
        .into_iter()
        .filter_map(|s| {
            let names = [s.meta_title.as_deref().unwrap_or(&s.series), s.series.as_str()];
            best_rank(&query, &names).map(|r| (r, s.rating, s))
        })
        .collect();

    let more = if params.more && query.chars().count() >= TMDB_MIN_CHARS {
        discover(&state, me.user.id, params.q.as_deref().unwrap_or_default(), &have_movies, &have_shows).await
    } else {
        Vec::new()
    };
    Ok(Json(FindResults {
        movies: ranked(movie_hits, LIBRARY_LIMIT),
        shows: ranked(show_hits, LIBRARY_LIMIT),
        more,
    }))
}

/// Only the "not in your library" results: the slow half of search, asked for separately so
/// library matches show at once.
async fn find_more(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Query(params): Query<MoreQuery>,
) -> ApiResult<Json<MoreResults>> {
    if normalize(&params.q).chars().count() < TMDB_MIN_CHARS {
        return Ok(Json(MoreResults { more: Vec::new() }));
    }
    let movies = movie_titles(&state, me.user.id, None).await?;
    let shows = library_shows(&state, me.user.id).await?;
    let have_movies: HashSet<String> = movies.iter().map(|t| t.id.clone()).collect();
    let have_shows: HashSet<i64> = shows.iter().filter_map(|s| s.tmdb_id).collect();
    let more = discover(&state, me.user.id, &params.q, &have_movies, &have_shows).await;
    Ok(Json(MoreResults { more }))
}

/// People whose name matches (TMDB's person search), the best known first, as a title's cast
/// is sent (their page by id, a headshot, and what they're known for as the role). None
/// without TMDB.
async fn find_people(
    State(state): State<AppState>,
    Query(params): Query<MoreQuery>,
) -> ApiResult<Json<Vec<super::titles::Person>>> {
    let q = params.q.trim();
    let Some(tmdb) = state.integrations().tmdb.clone() else {
        return Ok(Json(Vec::new()));
    };
    if normalize(q).chars().count() < TMDB_MIN_CHARS {
        return Ok(Json(Vec::new()));
    }
    let key = normalize(q);
    let cached = PEOPLE_FOUND
        .lock()
        .expect("people cache")
        .get(&key)
        .filter(|(at, _)| at.elapsed() < LOOKUP_TTL)
        .map(|(_, v)| v.clone());
    let found = if let Some(found) = cached {
        found
    } else {
        let found = tmdb.search_person(q).await.unwrap_or_default();
        insert_bounded(&mut PEOPLE_FOUND.lock().expect("people cache"), key, found.clone(), LOOKUP_TTL);
        found
    };
    Ok(Json(people_of(&state, found)))
}

/// The people worth showing (a headshot or some fame), best known first, at most [`PEOPLE_MAX`].
fn people_of(
    state: &AppState,
    mut found: Vec<panda_metadata::tmdb::SearchPerson>,
) -> Vec<super::titles::Person> {
    found.retain(|p| p.profile_path.is_some() || p.popularity >= PEOPLE_MIN_POPULARITY);
    found.sort_by(|a, b| b.popularity.total_cmp(&a.popularity));
    found
        .into_iter()
        .take(PEOPLE_MAX)
        .map(|p| super::titles::Person {
            id: Some(p.id),
            role: p
                .known_for
                .iter()
                .find_map(|k| k.title.clone().or_else(|| k.name.clone()))
                .or(p.known_for_department),
            image: p
                .profile_path
                .as_deref()
                .and_then(|path| super::images::promise(state, ImageSize::Profile, path)),
            name: p.name,
        })
        .collect()
}

/// People search: at most this many, and nobody without a photo below this popularity (TMDB
/// lists many namesakes with no work to speak of).
const PEOPLE_MAX: usize = 15;
const PEOPLE_MIN_POPULARITY: f64 = 2.0;
type PeopleFound = Vec<panda_metadata::tmdb::SearchPerson>;
static PEOPLE_FOUND: LazyLock<Mutex<HashMap<String, (Instant, PeopleFound)>>> =
    LazyLock::new(Default::default);

/// Entries each in-memory TMDB cache (previews, people, suggestions) may hold: keys come from
/// clients (any TMDB id), so they mustn't grow without limit.
const MEMORY_CACHE_MAX: usize = 500;

/// Insert into a time-stamped cache, keeping it bounded: when full, expired entries go first,
/// then everything (it refills from TMDB as needed).
fn insert_bounded<K: Eq + std::hash::Hash, V>(
    map: &mut HashMap<K, (Instant, V)>,
    key: K,
    value: V,
    ttl: Duration,
) {
    if map.len() >= MEMORY_CACHE_MAX {
        map.retain(|_, (at, _)| at.elapsed() < ttl);
        if map.len() >= MEMORY_CACHE_MAX {
            map.clear();
        }
    }
    map.insert(key, (Instant::now(), value));
}

/// How long one Radarr/Sonarr lookup may take (they search TMDB/TheTVDB themselves).
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
/// How long search waits for "not in your library" posters; the rest finish in the background.
const POSTER_BUDGET: Duration = Duration::from_secs(2);
/// Lookups are remembered this long (retyping, going back to a search).
const LOOKUP_TTL: Duration = Duration::from_secs(300);
const LOOKUP_CACHE_MAX: usize = 200;

type Lookup = (Vec<panda_arr::radarr::Movie>, Vec<panda_arr::sonarr::Series>);
static LOOKUPS: LazyLock<Mutex<HashMap<String, (Instant, Lookup)>>> = LazyLock::new(Default::default);

/// Drop remembered lookups: a request just put a title on a server, which they don't show.
pub(crate) fn forget_lookups() {
    LOOKUPS.lock().expect("lookup cache").clear();
}

/// Radarr's and Sonarr's lookups for `q`, both at once, each within `LOOKUP_TIMEOUT`; cached.
async fn lookup(state: &AppState, q: &str) -> Lookup {
    let key = normalize(q);
    if let Some((at, hit)) = LOOKUPS.lock().expect("lookup cache").get(&key)
        && at.elapsed() < LOOKUP_TTL
    {
        return hit.clone();
    }
    let integrations = state.integrations();
    let radarr = integrations.radarrs().into_iter().next().map(|(_, a)| a);
    let sonarr = integrations.sonarrs().into_iter().next().map(|(_, a)| a);
    let started = Instant::now();
    let (movies, shows) = tokio::join!(
        async {
            let Some(r) = &radarr else { return Some(Vec::new()) };
            match tokio::time::timeout(LOOKUP_TIMEOUT, r.client.lookup(q)).await {
                Ok(Ok(list)) => Some(list),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "Radarr search failed");
                    None
                }
                Err(_) => {
                    tracing::warn!("Radarr search timed out");
                    None
                }
            }
        },
        async {
            let Some(s) = &sonarr else { return Some(Vec::new()) };
            match tokio::time::timeout(LOOKUP_TIMEOUT, s.client.lookup(q)).await {
                Ok(Ok(list)) => Some(list),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "Sonarr search failed");
                    None
                }
                Err(_) => {
                    tracing::warn!("Sonarr search timed out");
                    None
                }
            }
        },
    );
    tracing::debug!(elapsed_ms = started.elapsed().as_millis(), "Radarr/Sonarr lookup");
    let complete = movies.is_some() && shows.is_some();
    let found = (movies.unwrap_or_default(), shows.unwrap_or_default());
    // Only complete answers are remembered (a timeout is worth retrying next time).
    if complete {
        let mut cache = LOOKUPS.lock().expect("lookup cache");
        if cache.len() >= LOOKUP_CACHE_MAX {
            cache.retain(|_, (at, _)| at.elapsed() < LOOKUP_TTL);
            if cache.len() >= LOOKUP_CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), found.clone()));
    }
    found
}

/// Titles you don't have yet, from Radarr's and Sonarr's own search (so they say whether the
/// server already has the title). Only for the kinds whose server is set up: without Radarr or
/// Sonarr there's nothing to download with, so search is library-only.
async fn discover(
    state: &AppState,
    user_id: i64,
    q: &str,
    have_movies: &HashSet<String>,
    have_shows: &HashSet<i64>,
) -> Vec<Discover> {
    if outside_hidden(state, user_id).await.unwrap_or(true) {
        return Vec::new();
    }
    let (movies, shows) = lookup(state, q).await;
    let mine: HashSet<(RequestKind, i64)> = state
        .db
        .requests_for_user(user_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.tmdb_id.map(|id| (r.kind, id)))
        .collect();
    let poster_url = |images: &[panda_arr::Image]| {
        images.iter().find(|i| i.cover_type == "poster").and_then(|i| i.remote_url.clone())
    };

    let movies = movies.into_iter().filter(|m| !have_movies.contains(&format!("m{}", m.tmdb_id))).map(|m| {
        let on_server = m.id.is_some();
        (
            Discover {
                kind: RequestKind::Movie,
                tmdb_id: m.tmdb_id,
                tvdb_id: None,
                year: m.year.map(i64::from),
                overview: m.overview.filter(|o| !o.is_empty()),
                rating: None,
                poster: None,
                requested: on_server || mine.contains(&(RequestKind::Movie, m.tmdb_id)),
                downloaded: m.has_file,
                can_request: !on_server,
                title: m.title,
            },
            poster_url(&m.images),
        )
    });
    let shows = shows.into_iter().filter(|s| s.tmdb_id.is_none_or(|id| !have_shows.contains(&id))).map(|s| {
        let on_server = s.id.is_some();
        let downloaded = s.statistics.as_ref().is_some_and(|st| st.episode_file_count > 0);
        (
            Discover {
                kind: RequestKind::Series,
                tmdb_id: s.tmdb_id.unwrap_or_default(),
                tvdb_id: Some(s.tvdb_id),
                year: s.year.map(i64::from),
                overview: s.overview.filter(|o| !o.is_empty()),
                rating: None,
                poster: None,
                requested: on_server || s.tmdb_id.is_some_and(|id| mine.contains(&(RequestKind::Series, id))),
                downloaded,
                can_request: !on_server,
                title: s.title,
            },
            poster_url(&s.images),
        )
    });
    // Both servers return best matches first: interleave them, then add posters.
    with_posters(state, interleave(movies.collect(), shows.collect(), MORE_LIMIT)).await
}

/// Alternate two best-first lists into one, up to `limit`.
fn interleave<T>(a: Vec<T>, b: Vec<T>, limit: usize) -> Vec<T> {
    let (mut a, mut b) = (a.into_iter(), b.into_iter());
    let mut out = Vec::new();
    while out.len() < limit {
        let (x, y) = (a.next(), b.next());
        if x.is_none() && y.is_none() {
            break;
        }
        out.extend(x);
        out.extend(y);
    }
    out.truncate(limit);
    out
}

/// Cache each result's poster URL, so the TV loads them like library artwork. Search waits at
/// most `POSTER_BUDGET`: posters still downloading then are left out this time and land in the
/// cache for the next search (each download runs as its own task).
async fn with_posters(state: &AppState, found: Vec<(Discover, Option<String>)>) -> Vec<Discover> {
    let tasks: Vec<_> = found
        .iter()
        .map(|(_, url)| {
            let images = state.images.clone();
            let url = url.clone();
            tokio::spawn(async move {
                match url {
                    Some(u) => images.fetch_remote(ImageSize::Poster, &u).await.ok().flatten(),
                    None => None,
                }
            })
        })
        .collect();
    let deadline = tokio::time::Instant::now() + POSTER_BUDGET;
    let posters = join_all(tasks.into_iter().map(|task| async move {
        tokio::time::timeout_at(deadline, task).await.ok().and_then(Result::ok).flatten()
    }))
    .await;
    found
        .into_iter()
        .zip(posters)
        .map(|((mut d, _), poster)| {
            d.poster = poster;
            d
        })
        .collect()
}

/// Streaming services shown as "Popular on ..." rows: (name, TMDB watch-provider id).
const PROVIDERS: [(&str, i64); 6] =
    [("Netflix", 8), ("Prime Video", 9), ("Disney+", 337), ("Max", 1899), ("Apple TV+", 350), ("Hulu", 15)];
/// TMDB lists change slowly: reuse them this long.
const DISCOVER_TTL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
/// Titles per row (after removing what you have).
const SET_LIMIT: usize = 20;

/// One row of titles you don't have, e.g. "Popular on Netflix".
#[derive(Debug, Clone, Serialize)]
struct DiscoverSet {
    title: String,
    items: Vec<Discover>,
}

/// Raw TMDB rows (posters cached), shared by every profile until they expire.
type SetCache = std::sync::Mutex<Option<(std::time::Instant, String, Vec<DiscoverSet>)>>;
static DISCOVER_CACHE: SetCache = std::sync::Mutex::new(None);

pub(super) fn to_discover(l: &panda_metadata::tmdb::Listing) -> Discover {
    Discover {
        kind: if l.is_movie() { RequestKind::Movie } else { RequestKind::Series },
        tmdb_id: l.id,
        tvdb_id: None,
        title: l.display_title().to_string(),
        year: l.year(),
        overview: l.overview.clone().filter(|o| !o.is_empty()),
        rating: l.vote_average.filter(|r| *r > 0.0),
        poster: None,
        requested: false,
        downloaded: false,
        can_request: false,
    }
}

/// Fetch the rows from TMDB: trending, then each service (movies and shows interleaved).
async fn fetch_sets(state: &AppState, tmdb: &panda_metadata::Tmdb, region: &str) -> Vec<DiscoverSet> {
    let with_paths = |ls: Vec<panda_metadata::tmdb::Listing>| -> Vec<(Discover, Option<String>)> {
        ls.into_iter().map(|l| (to_discover(&l), l.poster_path)).collect()
    };
    let trending = tmdb.trending().await.inspect_err(|e| tracing::warn!(error = %e, "TMDB trending failed"));
    let mut rows = vec![("Trending this week".to_string(), with_paths(trending.unwrap_or_default()))];
    let per_provider = join_all(PROVIDERS.iter().map(|(name, id)| async move {
        let (m, t) = tokio::join!(tmdb.on_provider(true, *id, region), tmdb.on_provider(false, *id, region));
        let (m, t) = (m.unwrap_or_default(), t.unwrap_or_default());
        (format!("Popular on {name}"), interleave(with_paths(m), with_paths(t), SET_LIMIT * 2))
    }))
    .await;
    rows.extend(per_provider);

    let mut out = Vec::new();
    for (title, found) in rows {
        if found.is_empty() {
            continue;
        }
        // Posters via the image cache (TMDB paths), like library artwork.
        let posters = join_all(found.iter().map(|(_, path)| async move {
            match path {
                Some(p) => state.images.fetch(tmdb, ImageSize::Poster, p).await.ok().flatten(),
                None => None,
            }
        }))
        .await;
        let items = found
            .into_iter()
            .zip(posters)
            .map(|((mut d, _), poster)| {
                d.poster = poster;
                d
            })
            .collect();
        out.push(DiscoverSet { title, items });
    }
    out
}

/// What Radarr/Sonarr already have, by TMDB id: `true` once something is on disk.
type OnServers = (HashMap<i64, bool>, HashMap<i64, bool>);
/// Reused briefly: opening Search shouldn't list every movie on every server each time.
static SERVERS_CACHE: std::sync::Mutex<Option<(std::time::Instant, OnServers)>> = std::sync::Mutex::new(None);
const SERVERS_TTL: std::time::Duration = std::time::Duration::from_secs(60);
/// Each server list call gets this long; a slow server just doesn't mark titles.
const SERVERS_TIMEOUT: Duration = Duration::from_secs(4);

/// Titles on any Radarr (movies) or Sonarr (shows), so popular rows can say "Requested" or
/// "Downloaded" for things added outside Panda or by someone else.
async fn on_servers(state: &AppState) -> OnServers {
    if let Some((at, v)) = SERVERS_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref()
        && at.elapsed() < SERVERS_TTL
    {
        return v.clone();
    }
    let integrations = state.integrations();
    let mut movies: HashMap<i64, bool> = HashMap::new();
    let mut shows: HashMap<i64, bool> = HashMap::new();
    for (_, r) in integrations.radarrs() {
        if let Ok(Ok(list)) = tokio::time::timeout(SERVERS_TIMEOUT, r.client.movies()).await {
            for m in list {
                *movies.entry(m.tmdb_id).or_default() |= m.has_file;
            }
        }
    }
    for (_, s) in integrations.sonarrs() {
        if let Ok(Ok(list)) = tokio::time::timeout(SERVERS_TIMEOUT, s.client.all_series()).await {
            for x in list {
                if let Some(id) = x.tmdb_id {
                    let files = x.statistics.as_ref().is_some_and(|st| st.episode_file_count > 0);
                    *shows.entry(id).or_default() |= files;
                }
            }
        }
    }
    let v = (movies, shows);
    *SERVERS_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((std::time::Instant::now(), v.clone()));
    v
}

/// Search's empty screen: rows of popular titles you don't have yet (trending, and per
/// streaming service), each requestable. Empty without TMDB.
async fn discover_sets(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<DiscoverSet>>> {
    let integrations = state.integrations();
    let Some(tmdb) = integrations.tmdb.clone() else { return Ok(Json(Vec::new())) };
    let region = state.config.tmdb.region.clone().unwrap_or_else(|| "US".into()).to_uppercase();

    let cached = {
        let guard = DISCOVER_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .as_ref()
            .filter(|(at, r, _)| *r == region && at.elapsed() < DISCOVER_TTL)
            .map(|(_, _, sets)| sets.clone())
    };
    let sets = if let Some(s) = cached {
        s
    } else {
        let s = fetch_sets(&state, &tmdb, &region).await;
        if !s.is_empty() {
            *DISCOVER_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some((std::time::Instant::now(), region, s.clone()));
        }
        s
    };

    let mut out = Vec::new();
    for set in sets {
        let mut items = for_profile(&state, me.user.id, set.items).await?;
        items.truncate(SET_LIMIT);
        if !items.is_empty() {
            out.push(DiscoverSet { title: set.title, items });
        }
    }
    Ok(Json(out))
}

/// Titles you don't have, for one profile: what's in your library dropped; each marked as
/// requested (by you, or already on Radarr/Sonarr), downloaded, or requestable.
/// What this profile has asked for (kind, TMDB id).
async fn my_requests(state: &AppState, user_id: i64) -> ApiResult<HashSet<(RequestKind, i64)>> {
    Ok(state
        .db
        .requests_for_user(user_id)
        .await?
        .into_iter()
        .filter_map(|r| r.tmdb_id.map(|id| (r.kind, id)))
        .collect())
}

/// A profile with an age limit sees nothing from outside the library: TMDB's lists, suggestions,
/// people's other work and pages of titles you don't have carry no rating Panda checked.
pub(super) async fn outside_hidden(state: &AppState, user_id: i64) -> ApiResult<bool> {
    Ok(crate::auth::access(state, user_id).await?.limited())
}

pub(super) async fn for_profile(
    state: &AppState,
    user_id: i64,
    items: Vec<Discover>,
) -> ApiResult<Vec<Discover>> {
    if outside_hidden(state, user_id).await? {
        return Ok(Vec::new());
    }
    let integrations = state.integrations();
    // Per profile: drop what's in your library; mark what you've asked for.
    let have_movies: HashSet<String> =
        movie_titles(state, user_id, None).await?.into_iter().map(|t| t.id).collect();
    let have_shows: HashSet<i64> =
        library_shows(state, user_id).await?.into_iter().filter_map(|s| s.tmdb_id).collect();
    let mine = my_requests(state, user_id).await?;
    let servers = on_servers(state).await;
    let can = |k: RequestKind| match k {
        RequestKind::Movie => !integrations.radarrs().is_empty(),
        RequestKind::Series => !integrations.sonarrs().is_empty(),
    };
    Ok(items
        .into_iter()
        .filter(|d| match d.kind {
            RequestKind::Movie => !have_movies.contains(&format!("m{}", d.tmdb_id)),
            RequestKind::Series => !have_shows.contains(&d.tmdb_id),
        })
        .map(|mut d| {
            let on = match d.kind {
                RequestKind::Movie => servers.0.get(&d.tmdb_id),
                RequestKind::Series => servers.1.get(&d.tmdb_id),
            };
            d.downloaded = on.copied().unwrap_or(false);
            d.requested = on.is_some() || mine.contains(&(d.kind, d.tmdb_id));
            d.can_request = !d.requested && can(d.kind);
            d
        })
        .collect())
}

/// Genres present in the libraries this user can see (for the search screen's shortcuts).
async fn genres(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<String>>> {
    let movies = movie_titles(&state, me.user.id, None).await?;
    let shows = library_shows(&state, me.user.id).await?;
    let all: BTreeSet<String> = movies
        .iter()
        .filter_map(|t| t.genres.as_deref())
        .chain(shows.iter().filter_map(|s| s.genres.as_deref()))
        .flat_map(|g| g.split(','))
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect();
    Ok(Json(all.into_iter().collect()))
}

/// TMDB recommendations per movie (posters cached), shared by every profile until they expire.
type SuggestionCache = std::sync::Mutex<HashMap<i64, (std::time::Instant, Vec<Discover>)>>;
static SUGGESTIONS: std::sync::LazyLock<SuggestionCache> = std::sync::LazyLock::new(Default::default);
const SUGGESTIONS_LIMIT: usize = 12;

/// "More like this" beyond the library: TMDB's recommendations for a movie that you don't have,
/// each requestable like Search's rows. Empty without TMDB, or without Radarr (nothing to
/// download them with).
async fn title_suggestions(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Discover>>> {
    // The same access check as the title itself.
    if !movie_titles(&state, me.user.id, None).await?.iter().any(|t| t.id == id) {
        return Err(ApiError::NotFound);
    }
    let Some(tmdb_id) = id.strip_prefix('m').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(Json(Vec::new()));
    };
    Ok(Json(recommendations(&state, me.user.id, RequestKind::Movie, tmdb_id).await?))
}

/// TMDB's recommendations for a title (cached `DISCOVER_TTL`, posters fetched), minus what's in
/// this profile's library, marked when they're on their way. Empty without TMDB or without a
/// server to request that kind from.
async fn recommendations(
    state: &AppState,
    user_id: i64,
    kind: RequestKind,
    tmdb_id: i64,
) -> ApiResult<Vec<Discover>> {
    let integrations = state.integrations();
    let can = match kind {
        RequestKind::Movie => !integrations.radarrs().is_empty(),
        RequestKind::Series => !integrations.sonarrs().is_empty(),
    };
    let (Some(tmdb), true) = (integrations.tmdb.clone(), can) else { return Ok(Vec::new()) };
    if outside_hidden(state, user_id).await? {
        return Ok(Vec::new());
    }
    let cache = match kind {
        RequestKind::Movie => &SUGGESTIONS,
        RequestKind::Series => &SHOW_SUGGESTIONS,
    };
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&tmdb_id)
        .filter(|(at, _)| at.elapsed() < DISCOVER_TTL)
        .map(|(_, v)| v.clone());
    let found = if let Some(v) = cached {
        v
    } else {
        let recs = match kind {
            RequestKind::Movie => tmdb.movie_recommendations(tmdb_id).await,
            RequestKind::Series => tmdb.tv_recommendations(tmdb_id).await,
        }
        .inspect_err(|e| tracing::warn!(tmdb_id, error = %e, "TMDB recommendations failed"))
        .unwrap_or_default();
        let (images, tmdbr) = (&state.images, &*tmdb);
        let posters = join_all(recs.iter().map(|l| async move {
            images.fetch(tmdbr, ImageSize::Poster, l.poster_path.as_deref()?).await.ok().flatten()
        }))
        .await;
        let v: Vec<Discover> =
            recs.iter().zip(posters).map(|(l, poster)| Discover { poster, ..to_discover(l) }).collect();
        insert_bounded(
            &mut cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            tmdb_id,
            v.clone(),
            DISCOVER_TTL,
        );
        v
    };
    // Per profile: drop what's in your library; mark what's on its way.
    let have: HashSet<i64> = match kind {
        RequestKind::Movie => movie_titles(state, user_id, None)
            .await?
            .into_iter()
            .filter_map(|t| t.id.strip_prefix('m').and_then(|n| n.parse().ok()))
            .collect(),
        RequestKind::Series => {
            library_shows(state, user_id).await?.into_iter().filter_map(|s| s.tmdb_id).collect()
        }
    };
    let mine: HashSet<i64> = state
        .db
        .requests_for_user(user_id)
        .await?
        .into_iter()
        .filter(|r| r.kind == kind)
        .filter_map(|r| r.tmdb_id)
        .collect();
    let servers = on_servers(state).await;
    let on_server = match kind {
        RequestKind::Movie => &servers.0,
        RequestKind::Series => &servers.1,
    };
    Ok(found
        .into_iter()
        .filter(|d| !have.contains(&d.tmdb_id))
        .map(|mut d| {
            let on = on_server.get(&d.tmdb_id);
            d.downloaded = on.copied().unwrap_or(false);
            d.requested = on.is_some() || mine.contains(&d.tmdb_id);
            d.can_request = !d.requested;
            d
        })
        .take(SUGGESTIONS_LIMIT)
        .collect())
}

/// A film series' films: the name and each film (TMDB id order), posters cached.
type CollectionCache = Mutex<HashMap<i64, (Instant, (String, Vec<(Option<i64>, Discover)>))>>;
static COLLECTIONS: LazyLock<CollectionCache> = LazyLock::new(Default::default);

/// A movie's series of films (sequels, prequels), oldest first.
#[derive(Debug, Clone, Serialize)]
struct CollectionView {
    name: String,
    items: Vec<CollectionItem>,
}

/// One film of a series: yours (`title`), or one you could request (`suggestion`).
#[derive(Debug, Clone, Serialize)]
struct CollectionItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<Title>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggestion: Option<Discover>,
}

/// The series of films a movie in your library is part of (`null`: none, or only this film).
/// Films you have open their page; others can be requested (marked when they're on their way).
async fn title_collection(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<Option<CollectionView>>> {
    let titles = movie_titles(&state, me.user.id, None).await?;
    // The same access check as the title itself.
    if !titles.iter().any(|t| t.id == id) {
        return Err(ApiError::NotFound);
    }
    let Some(tmdb) = state.integrations().tmdb.clone() else { return Ok(Json(None)) };
    let Some(tmdb_id) = id.strip_prefix('m').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(Json(None));
    };
    let Some(link) = super::titles::movie_details(&state, tmdb_id).await?.collection else {
        return Ok(Json(None));
    };
    Ok(Json(collection_view(&state, &tmdb, me.user.id, &titles, link.id).await?))
}

/// A film series (TMDB collection) as this profile sees it: films it has (`titles`) open their
/// page, others can be requested. `None` for a series of fewer than two films.
async fn collection_view(
    state: &AppState,
    tmdb: &panda_metadata::Tmdb,
    user_id: i64,
    titles: &[Title],
    collection_id: i64,
) -> ApiResult<Option<CollectionView>> {
    let cached = COLLECTIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&collection_id)
        .filter(|(at, _)| at.elapsed() < DISCOVER_TTL)
        .map(|(_, v)| v.clone());
    let (name, parts) = if let Some(v) = cached {
        v
    } else {
        let c = tmdb.collection(collection_id).await.map_err(ApiError::Metadata)?;
        let images = &state.images;
        let posters = join_all(c.parts.iter().map(|l| async move {
            match &l.poster_path {
                Some(p) => images.fetch(tmdb, ImageSize::Poster, p).await.ok().flatten(),
                None => None,
            }
        }))
        .await;
        let mut parts: Vec<(Option<i64>, Discover)> = c
            .parts
            .iter()
            .zip(posters)
            .map(|(l, poster)| (l.year(), Discover { poster, ..to_discover(l) }))
            .collect();
        // Oldest first; unreleased (no date) last.
        parts.sort_by_key(|(year, _)| year.unwrap_or(i64::MAX));
        let v = (c.name, parts);
        insert_bounded(
            &mut COLLECTIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            collection_id,
            v.clone(),
            DISCOVER_TTL,
        );
        v
    };
    if parts.len() < 2 {
        return Ok(None);
    }
    // An age limit: only the films of the series in the library (and within the limit).
    let hide_outside = outside_hidden(state, user_id).await?;
    let mine: HashSet<i64> = state
        .db
        .requests_for_user(user_id)
        .await?
        .into_iter()
        .filter(|r| r.kind == RequestKind::Movie)
        .filter_map(|r| r.tmdb_id)
        .collect();
    let servers = on_servers(state).await;
    let can_request = !state.integrations().radarrs().is_empty();
    let items: Vec<CollectionItem> = parts
        .into_iter()
        .filter(|(_, d)| !hide_outside || titles.iter().any(|t| t.id == format!("m{}", d.tmdb_id)))
        .map(|(_, mut d)| {
            if let Some(t) = titles.iter().find(|t| t.id == format!("m{}", d.tmdb_id)) {
                return CollectionItem { title: Some(t.clone()), suggestion: None };
            }
            let on = servers.0.get(&d.tmdb_id);
            d.downloaded = on.copied().unwrap_or(false);
            d.requested = on.is_some() || mine.contains(&d.tmdb_id);
            d.can_request = can_request && !d.requested;
            CollectionItem { title: None, suggestion: Some(d) }
        })
        .collect();
    if items.len() < 2 {
        return Ok(None);
    }
    Ok(Some(CollectionView { name, items }))
}

/// A title you don't have, as a full page: TMDB's details plus cast and crew, and whether it's
/// requested, on its way or downloaded. `library` names it when it's in your library after all
/// (the TV opens that page instead).
#[derive(Debug, Clone, Serialize)]
struct Preview {
    #[serde(flatten)]
    item: Discover,
    backdrop: Option<String>,
    genres: Option<String>,
    runtime_mins: Option<i64>,
    seasons: Option<i64>,
    details: super::titles::TitleDetails,
    /// In your library: the title id (`m603`) or show name to open instead.
    library: Option<String>,
    /// Movies: the series of films it's part of, as this profile sees it.
    collection: Option<CollectionView>,
    /// TMDB's recommendations not in the library (only with a server to request them from).
    more: Vec<Discover>,
}

type PreviewCache = std::sync::Mutex<HashMap<(RequestKind, i64), (std::time::Instant, Preview)>>;
static PREVIEWS: std::sync::LazyLock<PreviewCache> = std::sync::LazyLock::new(Default::default);

async fn preview(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path((kind, tmdb_id)): Path<(String, i64)>,
) -> ApiResult<Json<Preview>> {
    let kind = match kind.as_str() {
        "movie" => RequestKind::Movie,
        "series" => RequestKind::Series,
        _ => return Err(ApiError::NotFound),
    };
    let integrations = state.integrations();
    let Some(tmdb) = integrations.tmdb.clone() else { return Err(ApiError::NotFound) };
    // Titles you don't have aren't shown to a profile with an age limit (no rating checked).
    if outside_hidden(&state, me.user.id).await? {
        return Err(ApiError::NotFound);
    }
    let cached = PREVIEWS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(kind, tmdb_id))
        .filter(|(at, _)| at.elapsed() < DISCOVER_TTL)
        .map(|(_, p)| p.clone());
    let mut p = if let Some(p) = cached {
        p
    } else {
        let p = fetch_preview(&state, &tmdb, kind, tmdb_id).await?;
        insert_bounded(
            &mut PREVIEWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            (kind, tmdb_id),
            p.clone(),
            DISCOVER_TTL,
        );
        p
    };
    // Per profile: is it yours already, asked for, on a server?
    p.library = match kind {
        RequestKind::Movie => {
            let id = format!("m{tmdb_id}");
            movie_titles(&state, me.user.id, None).await?.into_iter().any(|t| t.id == id).then_some(id)
        }
        RequestKind::Series => library_shows(&state, me.user.id)
            .await?
            .into_iter()
            .find(|s| s.tmdb_id == Some(tmdb_id))
            .map(|s| s.series),
    };
    let mine = state
        .db
        .requests_for_user(me.user.id)
        .await?
        .iter()
        .any(|r| r.kind == kind && r.tmdb_id == Some(tmdb_id));
    let servers = on_servers(&state).await;
    let on = match kind {
        RequestKind::Movie => servers.0.get(&tmdb_id),
        RequestKind::Series => servers.1.get(&tmdb_id),
    };
    let can = match kind {
        RequestKind::Movie => !integrations.radarrs().is_empty(),
        RequestKind::Series => !integrations.sonarrs().is_empty(),
    };
    p.item.downloaded = on.copied().unwrap_or(false);
    p.item.requested = on.is_some() || mine;
    p.item.can_request = can && !p.item.requested;
    if p.library.is_some() {
        return Ok(Json(p));
    }
    // As much as a title you have shows: logo, ratings, its film series, similar titles.
    let mk = match kind {
        RequestKind::Movie => panda_db::MetadataKind::Movie,
        RequestKind::Series => panda_db::MetadataKind::Series,
    };
    let kind_name = if kind == RequestKind::Movie { "movie" } else { "series" };
    let ids = [tmdb_id];
    let collection = async {
        let Some(link) = p.details.collection.as_ref().filter(|_| kind == RequestKind::Movie) else {
            return Ok(None);
        };
        let titles = movie_titles(&state, me.user.id, None).await?;
        collection_view(&state, &tmdb, me.user.id, &titles, link.id).await
    };
    let (logos, ratings, collection, more) = tokio::join!(
        super::home_more::logos_for(&state, kind_name, mk, &ids),
        crate::services::providers::ratings(&state, mk, tmdb_id, p.details.tmdb_rating.or(p.item.rating)),
        collection,
        recommendations(&state, me.user.id, kind, tmdb_id),
    );
    p.details.logo = logos.get(&tmdb_id).cloned().flatten();
    p.details.ratings = ratings;
    p.collection = collection.unwrap_or_else(|e| {
        tracing::warn!(tmdb_id, error = %e, "film series failed");
        None
    });
    p.more = more?;
    Ok(Json(p))
}

async fn fetch_preview(
    state: &AppState,
    tmdb: &panda_metadata::Tmdb,
    kind: RequestKind,
    tmdb_id: i64,
) -> ApiResult<Preview> {
    let region = state.config.tmdb.region.clone().unwrap_or_else(|| "US".into());
    let image = |size: ImageSize, path: Option<String>| async move {
        state.images.fetch(tmdb, size, &path?).await.ok().flatten()
    };
    let genres = |g: &[panda_metadata::tmdb::Genre]| {
        (!g.is_empty()).then(|| g.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "))
    };
    let year = |d: Option<&str>| d.and_then(|d| d.get(..4)).and_then(|y| y.parse().ok());
    let not_found = |e: panda_metadata::Error| {
        tracing::warn!(tmdb_id, error = %e, "TMDB details failed");
        ApiError::NotFound
    };
    Ok(match kind {
        RequestKind::Movie => {
            let full = tmdb.movie_full(tmdb_id).await.map_err(not_found)?;
            let (poster, backdrop) = tokio::join!(
                image(ImageSize::Poster, full.poster_path.clone()),
                image(ImageSize::Backdrop, full.backdrop_path.clone()),
            );
            let details = super::titles::build_details(state, &full, &region);
            Preview {
                item: Discover {
                    kind,
                    tmdb_id,
                    tvdb_id: None,
                    title: full.title.clone().unwrap_or_default(),
                    year: year(full.release_date.as_deref()),
                    overview: full.overview.clone().filter(|o| !o.is_empty()),
                    rating: full.vote_average.filter(|r| *r > 0.0),
                    poster,
                    requested: false,
                    downloaded: false,
                    can_request: false,
                },
                backdrop,
                genres: genres(&full.genres),
                runtime_mins: full.runtime.filter(|r| *r > 0),
                seasons: None,
                details,
                library: None,
                collection: None,
                more: Vec::new(),
            }
        }
        RequestKind::Series => {
            let full = tmdb.tv_full(tmdb_id).await.map_err(not_found)?;
            let (poster, backdrop) = tokio::join!(
                image(ImageSize::Poster, full.poster_path.clone()),
                image(ImageSize::Backdrop, full.backdrop_path.clone()),
            );
            let details = super::titles::build_tv_details(state, &full, &region);
            Preview {
                item: Discover {
                    kind,
                    tmdb_id,
                    tvdb_id: None,
                    title: full.name.clone().unwrap_or_default(),
                    year: year(full.first_air_date.as_deref()),
                    overview: full.overview.clone().filter(|o| !o.is_empty()),
                    rating: full.vote_average.filter(|r| *r > 0.0),
                    poster,
                    requested: false,
                    downloaded: false,
                    can_request: false,
                },
                backdrop,
                genres: genres(&full.genres),
                runtime_mins: None,
                seasons: full.number_of_seasons,
                details,
                library: None,
                collection: None,
                more: Vec::new(),
            }
        }
    })
}

/// A person's page: who they are, their titles in your library, and the rest of their work
/// by role (requestable, like Search's rows).
#[derive(Debug, Clone, Serialize)]
struct PersonPage {
    name: String,
    biography: Option<String>,
    birthday: Option<String>,
    deathday: Option<String>,
    place_of_birth: Option<String>,
    known_for: Option<String>,
    image: Option<String>,
    /// The page's backdrop: one of theirs in your library, else their best-known title's.
    backdrop: Option<String>,
    movies: Vec<Title>,
    shows: Vec<SeriesSummary>,
    /// Their other work by role, their main one first; what's in your library left out.
    roles: Vec<RoleRow>,
}

/// One kind of work ("Movies", "Directed", "Guest appearances": English, the app translates).
#[derive(Debug, Clone, Serialize)]
struct RoleRow {
    role: &'static str,
    items: Vec<Discover>,
}

/// TMDB's side of a person page (shared by every profile until it expires).
#[derive(Debug, Clone)]
struct PersonBase {
    page: PersonPage,
    /// Their movies and shows (TMDB ids), each with how big their part is: the billing order
    /// for roles (0 = top billed), 0 for directing, writing or producing it.
    movie_ids: HashMap<i64, i64>,
    show_ids: HashMap<i64, i64>,
}

static PEOPLE: std::sync::LazyLock<std::sync::Mutex<HashMap<i64, (std::time::Instant, PersonBase)>>> =
    std::sync::LazyLock::new(Default::default);
/// Titles per role row (more are fetched: the profile's library takes some out).
const PERSON_ROW_LIMIT: usize = 20;

async fn person(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<Json<PersonPage>> {
    let integrations = state.integrations();
    let Some(tmdb) = integrations.tmdb.clone() else { return Err(ApiError::NotFound) };
    let cached = PEOPLE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .filter(|(at, _)| at.elapsed() < DISCOVER_TTL)
        .map(|(_, b)| b.clone());
    let base = if let Some(b) = cached {
        b
    } else {
        let b = fetch_person(&state, &tmdb, id).await?;
        insert_bounded(
            &mut PEOPLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            id,
            b.clone(),
            DISCOVER_TTL,
        );
        b
    };
    // Per profile: theirs in your library first; the rest is what you could ask for.
    let mut movies: Vec<Title> = movie_titles(&state, me.user.id, None)
        .await?
        .into_iter()
        .filter(|t| {
            t.id.strip_prefix('m')
                .and_then(|n| n.parse().ok())
                .is_some_and(|n: i64| base.movie_ids.contains_key(&n))
        })
        .collect();
    // Their big parts first (a cameo last), newest first among those.
    let part = |id: &str| {
        id.strip_prefix('m').and_then(|n| n.parse::<i64>().ok()).and_then(|n| base.movie_ids.get(&n).copied())
    };
    movies.sort_by_key(|t| (lead_tier(part(&t.id)), std::cmp::Reverse(t.year)));
    let have_movies: HashSet<String> = movies.iter().map(|t| t.id.clone()).collect();
    let mut shows: Vec<SeriesSummary> = library_shows(&state, me.user.id)
        .await?
        .into_iter()
        .filter(|s| s.tmdb_id.is_some_and(|t| base.show_ids.contains_key(&t)))
        .collect();
    shows.sort_by_key(|s| {
        (lead_tier(s.tmdb_id.and_then(|t| base.show_ids.get(&t).copied())), std::cmp::Reverse(s.year))
    });
    let have_shows: HashSet<i64> = shows.iter().filter_map(|s| s.tmdb_id).collect();
    let mine = my_requests(&state, me.user.id).await?;
    let servers = on_servers(&state).await;
    let can = |k: RequestKind| match k {
        RequestKind::Movie => !integrations.radarrs().is_empty(),
        RequestKind::Series => !integrations.sonarrs().is_empty(),
    };
    let hide_outside = outside_hidden(&state, me.user.id).await?;
    let roles = base
        .page
        .roles
        .iter()
        .filter(|_| !hide_outside)
        .map(|row| RoleRow {
            role: row.role,
            items: row
                .items
                .iter()
                .filter(|d| match d.kind {
                    RequestKind::Movie => !have_movies.contains(&format!("m{}", d.tmdb_id)),
                    RequestKind::Series => !have_shows.contains(&d.tmdb_id),
                })
                .take(PERSON_ROW_LIMIT)
                .cloned()
                .map(|mut d| {
                    let on = match d.kind {
                        RequestKind::Movie => servers.0.get(&d.tmdb_id),
                        RequestKind::Series => servers.1.get(&d.tmdb_id),
                    };
                    d.downloaded = on.copied().unwrap_or(false);
                    d.requested = on.is_some() || mine.contains(&(d.kind, d.tmdb_id));
                    d.can_request = !d.requested && can(d.kind);
                    d
                })
                .collect(),
        })
        .filter(|row| !row.items.is_empty())
        .collect();
    // Over one of their titles you have where they have a big part (never a cameo's), else
    // their best-known title's.
    let lead = |tier: u8| tier < 2;
    let backdrop = movies
        .iter()
        .filter(|t| lead(lead_tier(part(&t.id))))
        .find_map(|t| t.backdrop.clone())
        .or_else(|| {
            shows
                .iter()
                .filter(|s| lead(lead_tier(s.tmdb_id.and_then(|t| base.show_ids.get(&t).copied()))))
                .find_map(|s| s.backdrop.clone())
        })
        .or_else(|| if hide_outside { None } else { base.page.backdrop.clone() });
    Ok(Json(PersonPage { backdrop, movies, shows, roles, ..base.page }))
}

/// How big a part is, from its billing order: 0 a lead (top three, or behind the camera), 1 a
/// supporting part, 2 a small one (or unknown).
fn lead_tier(order: Option<i64>) -> u8 {
    match order {
        Some(0..=2) => 0,
        Some(3..=9) => 1,
        _ => 2,
    }
}

/// Which row a credit belongs in (`None`: not shown: appearances as themselves, other crew).
fn role_of(c: &panda_metadata::tmdb::PersonCredit, crew: bool) -> Option<&'static str> {
    if c.is_appearance() {
        return None;
    }
    if crew {
        return match c.department.as_deref() {
            Some("Directing") if c.job.as_deref() == Some("Director") => Some("Directed"),
            Some("Writing") => Some("Written"),
            Some("Production") if c.job.as_deref().is_some_and(|j| j.contains("Producer")) => {
                Some("Produced")
            }
            _ => None,
        };
    }
    Some(if c.is_movie() {
        "Movies"
    } else if c.is_guest_spot() {
        "Guest appearances"
    } else {
        "Shows"
    })
}

/// Rows in order: acting first for actors, else their own department's row first; guest spots
/// always last.
fn role_order(known_for: Option<&str>) -> [&'static str; 6] {
    match known_for {
        Some("Directing") => ["Directed", "Written", "Produced", "Movies", "Shows", "Guest appearances"],
        Some("Writing") => ["Written", "Directed", "Produced", "Movies", "Shows", "Guest appearances"],
        Some("Production") => ["Produced", "Directed", "Written", "Movies", "Shows", "Guest appearances"],
        _ => ["Movies", "Shows", "Directed", "Written", "Produced", "Guest appearances"],
    }
}

async fn fetch_person(state: &AppState, tmdb: &panda_metadata::Tmdb, id: i64) -> ApiResult<PersonBase> {
    let full = tmdb.person(id).await.map_err(|e| {
        tracing::warn!(person = id, error = %e, "TMDB person failed");
        ApiError::NotFound
    })?;
    let credits = &full.combined_credits;
    let by_role: Vec<(&'static str, &panda_metadata::tmdb::PersonCredit)> = credits
        .cast
        .iter()
        .filter_map(|c| Some((role_of(c, false)?, c)))
        .chain(credits.crew.iter().filter_map(|c| Some((role_of(c, true)?, c))))
        .filter(|(_, c)| matches!(c.media_type.as_deref(), Some("movie" | "tv")))
        .collect();
    // "In your library" counts their real work, not guest spots; each title with their biggest
    // part in it (behind the camera counts as a lead).
    let mut movie_ids: HashMap<i64, i64> = HashMap::new();
    let mut show_ids: HashMap<i64, i64> = HashMap::new();
    for (role, c) in by_role.iter().filter(|(r, _)| *r != "Guest appearances") {
        let part = if matches!(*role, "Movies" | "Shows") { c.order.unwrap_or(99) } else { 0 };
        let ids = if c.is_movie() { &mut movie_ids } else { &mut show_ids };
        ids.entry(c.id).and_modify(|p| *p = (*p).min(part)).or_insert(part);
    }

    // Each row: unique titles with a poster, most popular first (twice a row's worth: the
    // profile's library takes some out).
    let mut rows: Vec<(&'static str, Vec<&panda_metadata::tmdb::PersonCredit>)> = Vec::new();
    for role in role_order(full.known_for_department.as_deref()) {
        let mut seen = HashSet::new();
        let mut items: Vec<_> = by_role
            .iter()
            .filter(|(r, c)| *r == role && c.poster_path.is_some())
            .map(|(_, c)| *c)
            .filter(|c| seen.insert((c.is_movie(), c.id)))
            .collect();
        items.sort_by(|a, b| b.popularity.unwrap_or(0.0).total_cmp(&a.popularity.unwrap_or(0.0)));
        items.truncate(PERSON_ROW_LIMIT * 2);
        if !items.is_empty() {
            rows.push((role, items));
        }
    }
    let images = &state.images;
    let poster = |c: &panda_metadata::tmdb::PersonCredit| {
        let path = c.poster_path.clone();
        async move { images.fetch(tmdb, ImageSize::Poster, path.as_deref()?).await.ok().flatten() }
    };
    let roles = join_all(rows.iter().map(|(role, items)| async move {
        let posters = join_all(items.iter().map(|c| poster(c))).await;
        RoleRow {
            role,
            items: items
                .iter()
                .zip(posters)
                .map(|(c, poster)| Discover { poster, ..to_discover(&c.listing()) })
                .collect(),
        }
    }))
    .await;
    // Their best-known title's backdrop, for when you have none of theirs.
    let best = by_role
        .iter()
        .filter(|(r, c)| {
            c.backdrop_path.is_some()
                && match *r {
                    "Guest appearances" => false,
                    "Movies" | "Shows" => lead_tier(c.order) == 0,
                    _ => true,
                }
        })
        .max_by(|a, b| a.1.popularity.unwrap_or(0.0).total_cmp(&b.1.popularity.unwrap_or(0.0)))
        .and_then(|(_, c)| c.backdrop_path.clone());
    let (image, backdrop) = tokio::join!(
        async {
            match &full.profile_path {
                Some(p) => images.fetch(tmdb, ImageSize::Profile, p).await.ok().flatten(),
                None => None,
            }
        },
        async {
            match &best {
                Some(p) => images.fetch(tmdb, ImageSize::Backdrop, p).await.ok().flatten(),
                None => None,
            }
        },
    );
    Ok(PersonBase {
        page: PersonPage {
            name: full.name,
            biography: full.biography.filter(|b| !b.trim().is_empty()),
            birthday: full.birthday,
            deathday: full.deathday,
            place_of_birth: full.place_of_birth,
            known_for: full.known_for_department,
            image,
            backdrop,
            movies: Vec::new(),
            shows: Vec::new(),
            roles,
        },
        movie_ids,
        show_ids,
    })
}

/// TMDB recommendations per show, like movies' (posters cached, shared until they expire).
static SHOW_SUGGESTIONS: std::sync::LazyLock<SuggestionCache> = std::sync::LazyLock::new(Default::default);

/// More Like This beyond the library for a show: TMDB's recommendations you don't have,
/// requestable. Empty without TMDB or Sonarr.
async fn series_suggestions(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
) -> ApiResult<Json<Vec<Discover>>> {
    let show = super::titles::visible_series(&state, me.user.id, &name).await?;
    let Some(tmdb_id) = show.tmdb_id else { return Ok(Json(Vec::new())) };
    Ok(Json(recommendations(&state, me.user.id, RequestKind::Series, tmdb_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credit(
        kind: &str,
        character: Option<&str>,
        job: Option<&str>,
        dept: Option<&str>,
        eps: Option<i64>,
    ) -> panda_metadata::tmdb::PersonCredit {
        panda_metadata::tmdb::PersonCredit {
            id: 1,
            media_type: Some(kind.into()),
            title: None,
            name: None,
            release_date: None,
            first_air_date: None,
            poster_path: None,
            backdrop_path: None,
            overview: None,
            vote_average: None,
            popularity: None,
            character: character.map(Into::into),
            job: job.map(Into::into),
            department: dept.map(Into::into),
            order: None,
            genre_ids: Vec::new(),
            episode_count: eps,
        }
    }

    #[test]
    fn credits_go_to_their_role_rows() {
        assert_eq!(role_of(&credit("movie", Some("Peter"), None, None, None), false), Some("Movies"));
        assert_eq!(role_of(&credit("tv", Some("Lead"), None, None, Some(40)), false), Some("Shows"));
        assert_eq!(
            role_of(&credit("tv", Some("Dr. Lee"), None, None, Some(1)), false),
            Some("Guest appearances")
        );
        assert_eq!(
            role_of(&credit("tv", Some("Himself"), None, None, Some(1)), false),
            None,
            "as themselves"
        );
        let crew = |job: &str, dept: &str| role_of(&credit("movie", None, Some(job), Some(dept), None), true);
        assert_eq!(crew("Director", "Directing"), Some("Directed"));
        assert_eq!(crew("Assistant Director", "Directing"), None);
        assert_eq!(crew("Screenplay", "Writing"), Some("Written"));
        assert_eq!(crew("Executive Producer", "Production"), Some("Produced"));
        assert_eq!(crew("Casting", "Production"), None);
        assert_eq!(role_order(Some("Directing"))[0], "Directed", "a director's page leads with their films");
        assert_eq!(lead_tier(Some(0)), 0, "top billed");
        assert_eq!(lead_tier(Some(5)), 1);
        assert_eq!(lead_tier(Some(24)), 2, "a cameo");
        assert_eq!(lead_tier(None), 2);
    }

    #[test]
    fn ranks_exact_then_prefix_then_word_then_anywhere() {
        let q = normalize("star");
        assert_eq!(best_rank(&q, &["Star"]), Some(0));
        assert_eq!(best_rank(&q, &["Star Wars"]), Some(1));
        assert_eq!(best_rank(&q, &["A Star Is Born"]), Some(2));
        assert_eq!(best_rank(&q, &["Lodestar"]), Some(3));
        assert_eq!(best_rank(&q, &["Alien"]), None);
    }

    #[test]
    fn matching_ignores_accents_case_and_punctuation() {
        assert_eq!(best_rank(&normalize("amelie"), &["Amélie"]), Some(0));
        assert_eq!(best_rank(&normalize("wall e"), &["WALL·E"]), Some(0));
        assert_eq!(best_rank(&normalize("spider man"), &["Spider-Man: No Way Home"]), Some(1));
        // Any of a show's names counts.
        assert_eq!(best_rank(&normalize("office"), &["The Office (US)", "The Office"]), Some(2));
    }

    #[test]
    fn better_matches_first_then_higher_rated() {
        let hits =
            vec![(3, Some(9.0), "anywhere"), (1, Some(6.0), "prefix low"), (1, Some(8.0), "prefix high")];
        assert_eq!(ranked(hits, 10), vec!["prefix high", "prefix low", "anywhere"]);
    }

    #[test]
    fn interleaves_best_first_lists() {
        assert_eq!(interleave(vec![1, 3, 5, 7], vec![2, 4], 5), vec![1, 2, 3, 4, 5]);
        assert_eq!(interleave(Vec::<i32>::new(), vec![2], 5), vec![2]);
    }

    #[test]
    fn genre_lists_are_comma_separated_and_case_insensitive() {
        assert!(has_genre(Some("Action, Science Fiction"), "science fiction"));
        assert!(!has_genre(Some("Action"), "Drama"));
        assert!(!has_genre(None, "Drama"));
    }
}

#[cfg(test)]
mod bounded_cache_tests {
    use super::*;

    #[test]
    fn memory_caches_stay_bounded() {
        let mut map: HashMap<i64, (Instant, ())> = HashMap::new();
        for id in 0..(MEMORY_CACHE_MAX as i64 * 3) {
            insert_bounded(&mut map, id, (), Duration::from_secs(3600));
            assert!(map.len() <= MEMORY_CACHE_MAX);
        }
    }
}
