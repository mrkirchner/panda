//! The rest of the Home screen (`GET /api/home/more`), loaded after `/api/home` so the first rows
//! show at once:
//!
//! - **Genre tiles**: the library's genres, most titles first, each with a backdrop from a top
//!   rated title of that genre (no backdrop used twice).
//! - **Spotlights** (wide banners) and **top picks** (tall cards): titles with a reason ("Because
//!   you watched X", "Top rated", "New episodes", "Unwatched"), rotating daily per profile like
//!   the hero (and never repeating it), with the title's logo from TMDB when it has one.
//! - **Themed rows**: holidays in season (Christmas from mid-November...) and two rotating
//!   themes a day (heists, time travel...): TMDB's best known titles with that keyword that
//!   are in the library, then (with Radarr/Sonarr) popular ones you don't have, requestable like
//!   Search's rows. Keyword lookups run at startup and twice a day, so this request never waits
//!   on them.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::Datelike;
use panda_db::SeriesSummary;
use panda_metadata::ImageSize;
use panda_metadata::tmdb::Listing;
use serde::Serialize;

use super::featured::{self, Rng};
use super::search::{Discover, for_profile, to_discover};
use super::titles::{Title, movie_titles};
use crate::auth::CurrentUser;
use crate::auth::access;
use crate::error::ApiResult;
use crate::services::settings::now;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/home/more", get(home_more))
}

const GENRE_TILES: usize = 10;
/// One banner: with the hero and the top picks, more felt like too much featuring.
const SPOTLIGHTS: usize = 1;
const TOP_PICKS: usize = 10;
/// A themed row needs this many titles from the library to show.
const THEME_MIN: usize = 4;
const THEME_MAX: usize = 20;
/// "Top rated": at least this TMDB score.
const TOP_RATED: f64 = 7.5;
/// "New episodes": a show's newest episode arrived within this many days.
const NEW_EPISODE_DAYS: i64 = 14;
/// Logos fetched for this request may take this long; the rest finish in the background.
const LOGO_WAIT: Duration = Duration::from_secs(3);
/// A title without a logo on TMDB is asked again after this long.
const NO_LOGO_RETRY_SECS: i64 = 30 * 86_400;

#[derive(Serialize)]
struct HomeMore {
    genres: Vec<GenreTile>,
    spotlights: Vec<Spot>,
    top_picks: Vec<Spot>,
    themed: Vec<ThemedRow>,
}

#[derive(Serialize)]
struct GenreTile {
    name: String,
    /// Where most of it is: "movies" or "shows" (the page the tile opens, filtered).
    kind: &'static str,
    backdrop: String,
    count: usize,
}

/// A featured title: a movie (`id` = its title id) or a show (`id` = its name).
#[derive(Serialize, Clone)]
pub(super) struct Spot {
    pub(super) kind: &'static str,
    pub(super) id: String,
    pub(super) title: String,
    pub(super) year: Option<i64>,
    pub(super) genres: Option<String>,
    pub(super) rating: Option<f64>,
    pub(super) poster: Option<String>,
    pub(super) backdrop: Option<String>,
    /// The title's logo (image key), when TMDB has one.
    pub(super) logo: Option<String>,
    /// English text, translated by the app: "Top rated", "Because you watched {title}"...
    pub(super) reason: &'static str,
    /// `{title}` in the reason.
    pub(super) reason_title: Option<String>,
    #[serde(skip)]
    pub(super) tmdb_id: Option<i64>,
}

#[derive(Serialize)]
struct ThemedRow {
    /// English, translated by the app ("Christmas", "Heists").
    title: &'static str,
    /// A holiday in season (rather than a rotating theme).
    seasonal: bool,
    /// In the library.
    items: Vec<Spot>,
    /// Popular ones you don't have, after them: requestable (or already on their way).
    more: Vec<Discover>,
}

pub(super) fn movie_spot(m: &Title, reason: &'static str, reason_title: Option<String>) -> Spot {
    Spot {
        kind: "movie",
        id: m.id.clone(),
        title: m.title.clone(),
        year: m.year,
        genres: m.genres.clone(),
        rating: m.rating,
        poster: m.poster.clone(),
        backdrop: m.backdrop.clone(),
        logo: None,
        reason,
        reason_title,
        tmdb_id: m.id.strip_prefix('m').and_then(|n| n.parse().ok()),
    }
}

pub(super) fn show_spot(s: &SeriesSummary, reason: &'static str) -> Spot {
    Spot {
        kind: "series",
        id: s.series.clone(),
        title: s.meta_title.clone().unwrap_or_else(|| s.series.clone()),
        year: s.year,
        genres: s.genres.clone(),
        rating: s.rating,
        poster: s.poster.clone(),
        backdrop: s.backdrop.clone(),
        logo: None,
        reason,
        reason_title: None,
        tmdb_id: s.tmdb_id,
    }
}

pub(super) fn genres_of(g: Option<&str>) -> impl Iterator<Item = &str> {
    g.unwrap_or_default().split(',').map(str::trim).filter(|g| !g.is_empty())
}

/// Genres by how many titles have them, each with a backdrop from its best rated title.
fn genre_tiles(movies: &[Title], shows: &[SeriesSummary]) -> Vec<GenreTile> {
    // (movies, shows) per genre.
    let mut counts: HashMap<&str, (usize, usize)> = HashMap::new();
    for m in movies {
        for g in genres_of(m.genres.as_deref()) {
            counts.entry(g).or_default().0 += 1;
        }
    }
    for s in shows {
        for g in genres_of(s.genres.as_deref()) {
            counts.entry(g).or_default().1 += 1;
        }
    }
    let mut order: Vec<(&str, (usize, usize))> = counts.into_iter().collect();
    order.sort_by(|a, b| (b.1.0 + b.1.1).cmp(&(a.1.0 + a.1.1)).then(a.0.cmp(b.0)));

    // Candidates for backdrops, best rated first.
    let mut art: Vec<(f64, &str, Option<&str>)> = movies
        .iter()
        .filter_map(|m| Some((m.rating.unwrap_or(0.0), m.backdrop.as_deref()?, m.genres.as_deref())))
        .chain(
            shows
                .iter()
                .filter_map(|s| Some((s.rating.unwrap_or(0.0), s.backdrop.as_deref()?, s.genres.as_deref()))),
        )
        .collect();
    art.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut used = HashSet::new();
    let mut out = Vec::new();
    for (name, (m, s)) in order {
        let backdrop = art
            .iter()
            .filter(|(_, b, g)| !used.contains(b) && genres_of(*g).any(|x| x == name))
            .map(|(_, b, _)| *b)
            .next();
        let Some(backdrop) = backdrop else { continue };
        used.insert(backdrop);
        out.push(GenreTile {
            name: name.to_string(),
            kind: if m >= s { "movies" } else { "shows" },
            backdrop: backdrop.to_string(),
            count: m + s,
        });
        if out.len() == GENRE_TILES {
            break;
        }
    }
    out
}

/// Rotating pools of featured titles, each shuffled with today's seed.
struct Pools {
    because: Vec<Spot>,
    top_movies: Vec<Spot>,
    new_episodes: Vec<Spot>,
    top_shows: Vec<Spot>,
    unwatched: Vec<Spot>,
}

impl Pools {
    /// One from each pool in turn (an empty pool is skipped), never a title twice.
    fn take(&mut self, n: usize, seen: &mut HashSet<String>) -> Vec<Spot> {
        let mut out = Vec::new();
        loop {
            let before = out.len();
            for pool in [
                &mut self.because,
                &mut self.top_movies,
                &mut self.new_episodes,
                &mut self.unwatched,
                &mut self.top_shows,
            ] {
                while let Some(s) = pool.pop() {
                    if seen.insert(format!("{}:{}", s.kind, s.id)) {
                        out.push(s);
                        break;
                    }
                }
                if out.len() == n {
                    return out;
                }
            }
            if out.len() == before {
                return out;
            }
        }
    }
}

async fn home_more(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<HomeMore>> {
    let movies = movie_titles(&state, me.user.id, None).await?;
    let access = access(&state, me.user.id).await?;
    let shows = crate::catalog::series(&state, &access).await?;
    let t = now();
    let seed = featured::daily_seed(t, me.user.id);

    // Never repeat the hero's titles.
    let mut featured_ids: HashSet<String> = featured::pick(&movies, &shows, super::watch::year_of(t), seed)
        .into_iter()
        .map(|(_, p)| match p {
            featured::Pick::Movie(i) => format!("movie:{}", movies[i].id),
            featured::Pick::Show(i) => format!("series:{}", shows[i].series),
        })
        .collect();

    let finished = |m: &Title| m.progress.as_ref().is_some_and(|p| p.finished);
    let has_art = |m: &Title| m.backdrop.is_some();
    let mut rng = Rng::new(seed ^ 0x5157);

    // "Because you watched X": TMDB's recommendations for the movie finished last, from the library.
    let mut because = Vec::new();
    if let Some(last) = movies
        .iter()
        .filter(|m| finished(m))
        .max_by_key(|m| m.progress.as_ref().map_or(0, |p| p.last_played_at))
        && let Some(id) = last.id.strip_prefix('m').and_then(|n| n.parse::<i64>().ok())
    {
        let recs = recommendations(&state, id).await;
        because = movies
            .iter()
            .filter(|m| !finished(m) && has_art(m) && recs.contains(&m.id))
            .map(|m| movie_spot(m, "Because you watched {title}", Some(last.title.clone())))
            .collect();
        rng.shuffle(&mut because);
    }
    let mut top_movies: Vec<Spot> = movies
        .iter()
        .filter(|m| !finished(m) && has_art(m) && m.rating.is_some_and(|r| r >= TOP_RATED))
        .map(|m| movie_spot(m, "Top rated", None))
        .collect();
    rng.shuffle(&mut top_movies);
    let mut unwatched: Vec<Spot> = movies
        .iter()
        .filter(|m| m.progress.is_none() && has_art(m))
        .map(|m| movie_spot(m, "Unwatched", None))
        .collect();
    rng.shuffle(&mut unwatched);
    let recent = chrono::Utc::now() - chrono::Duration::days(NEW_EPISODE_DAYS);
    let mut new_episodes: Vec<Spot> = shows
        .iter()
        .filter(|s| {
            s.backdrop.is_some()
                && chrono::DateTime::parse_from_rfc3339(&s.latest_added_at).is_ok_and(|d| d >= recent)
        })
        .map(|s| show_spot(s, "New episodes"))
        .collect();
    rng.shuffle(&mut new_episodes);
    let mut top_shows: Vec<Spot> = shows
        .iter()
        .filter(|s| s.backdrop.is_some() && s.rating.is_some_and(|r| r >= TOP_RATED))
        .map(|s| show_spot(s, "Top rated"))
        .collect();
    rng.shuffle(&mut top_shows);
    let mut pools = Pools { because, top_movies, new_episodes, top_shows, unwatched };

    let mut spotlights = pools.take(SPOTLIGHTS, &mut featured_ids);
    let mut top_picks = pools.take(TOP_PICKS, &mut featured_ids);
    add_logos(&state, spotlights.iter_mut().chain(top_picks.iter_mut())).await;

    let themed = themed_rows(&state, me.user.id, &movies, &shows, seed).await?;
    Ok(Json(HomeMore { genres: genre_tiles(&movies, &shows), spotlights, top_picks, themed }))
}

/// Logos for these titles: stored ones at once, missing ones from TMDB (waiting up to
/// [`LOGO_WAIT`]; slower ones are stored for next time).
pub(super) async fn add_logos<'a>(state: &AppState, spots: impl Iterator<Item = &'a mut Spot>) {
    let mut spots: Vec<&mut Spot> = spots.filter(|s| s.tmdb_id.is_some()).collect();
    for (kind, mk) in [("movie", panda_db::MetadataKind::Movie), ("series", panda_db::MetadataKind::Series)] {
        let ids: Vec<i64> = spots.iter().filter(|s| s.kind == kind).filter_map(|s| s.tmdb_id).collect();
        let found = logos_for(state, kind, mk, &ids).await;
        for s in spots.iter_mut().filter(|s| s.kind == kind) {
            s.logo = s.tmdb_id.and_then(|id| found.get(&id).cloned().flatten());
        }
    }
}

/// Logos (image keys) for these titles of one kind, by TMDB id: an extra provider's (Fanart.tv)
/// when it's ordered ahead of TMDB; else TMDB's, stored or fetched now (waiting up to
/// [`LOGO_WAIT`]; slower ones are stored for next time); else an extra provider's.
pub(crate) async fn logos_for(
    state: &AppState,
    kind: &'static str,
    mk: panda_db::MetadataKind,
    ids: &[i64],
) -> HashMap<i64, Option<String>> {
    let t = now();
    // Logos the extra providers cached at lookup: ahead of TMDB in the logos order they win
    // (and TMDB isn't asked); after it, they fill in where TMDB has none.
    let extra = crate::services::providers::extra_logos(state, mk, ids).await;
    let Ok(stored) = state.db.title_logos(kind, ids).await else { return HashMap::new() };
    let mut out: HashMap<i64, Option<String>> = ids
        .iter()
        .map(|id| {
            (*id, extra.before.get(id).cloned().or_else(|| stored.get(id).and_then(|(l, _)| l.clone())))
        })
        .collect();
    let missing: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| !extra.before.contains_key(id))
        .filter(|id| match stored.get(id) {
            None => true,
            Some((None, at)) => t - at > NO_LOGO_RETRY_SECS,
            Some((Some(_), _)) => false,
        })
        .collect();
    if !missing.is_empty()
        && let Some(tmdb) = state.integrations().tmdb.clone()
    {
        let fetch = {
            let state = state.clone();
            tokio::spawn(async move {
                let found = futures_util::future::join_all(missing.iter().map(|&id| {
                    let (tmdb, state) = (tmdb.clone(), state.clone());
                    async move {
                        let paths = tmdb.logos(kind == "series", id).await.ok()?;
                        let key = readable_logo(&state, &tmdb, &paths).await;
                        let _ = state.db.set_title_logo(kind, id, key.as_deref(), now()).await;
                        Some((id, key))
                    }
                }))
                .await;
                found.into_iter().flatten().collect::<HashMap<i64, Option<String>>>()
            })
        };
        if let Ok(Ok(found)) = tokio::time::timeout(LOGO_WAIT, fetch).await {
            out.extend(found);
        }
    }
    for (id, logo) in &mut out {
        if logo.is_none() {
            logo.clone_from(&extra.after.get(id).cloned());
        }
    }
    out
}

/// Logo candidates checked per title before giving up on a readable one.
const LOGO_TRIES: usize = 3;
/// Average lettering brightness (0-1, ignoring transparency) below which a logo is too dark to
/// read on the black cards (measured: Skyfall's dark-grey logo 0.13, typical ones 0.6-0.8).
const DARK_LOGO: f64 = 0.35;

/// The first of a title's logos that reads on black (fetched into the image cache), if any.
async fn readable_logo(state: &AppState, tmdb: &panda_metadata::Tmdb, paths: &[String]) -> Option<String> {
    for path in paths.iter().take(LOGO_TRIES) {
        let Ok(Some(key)) = state.images.fetch(tmdb, ImageSize::Logo, path).await else { continue };
        let Some(file) = state.images.path_for_key(&key) else { continue };
        match brightness(&state.ffmpeg.ffmpeg, &file).await {
            Some(b) if b < DARK_LOGO => tracing::debug!(key, brightness = b, "logo too dark; trying another"),
            // Bright enough, or unmeasurable (keep it rather than lose it).
            _ => return Some(key),
        }
    }
    None
}

/// Mean brightness of an image's visible pixels (0-1): alpha-weighted, so transparency
/// around the lettering doesn't count. `None` if ffmpeg can't tell.
async fn brightness(ffmpeg: &std::path::Path, file: &std::path::Path) -> Option<f64> {
    let run = tokio::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-v", "error", "-i"])
        .arg(file)
        .args([
            "-vf",
            "format=rgba,premultiply=inplace=1,scale=1:1:flags=area",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
    let [r, g, b, a] = <[u8; 4]>::try_from(out.stdout.get(..4)?).ok()?;
    if a == 0 {
        return None;
    }
    let luma = 0.2126 * f64::from(r) + 0.7152 * f64::from(g) + 0.0722 * f64::from(b);
    Some(luma / f64::from(a))
}

/// TMDB recommendations for a movie, as title ids (`m<id>`), cached a day.
async fn recommendations(state: &AppState, tmdb_id: i64) -> HashSet<String> {
    /// Per movie: when its recommendations were fetched, and them.
    type Recs = Mutex<HashMap<i64, (Instant, HashSet<String>)>>;
    static CACHE: LazyLock<Recs> = LazyLock::new(Default::default);
    if let Some((at, ids)) = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&tmdb_id)
        && at.elapsed() < Duration::from_secs(86_400)
    {
        return ids.clone();
    }
    let Some(tmdb) = state.integrations().tmdb.clone() else { return HashSet::new() };
    let Ok(Ok(recs)) = tokio::time::timeout(LOGO_WAIT, tmdb.movie_recommendations(tmdb_id)).await else {
        return HashSet::new();
    };
    let ids: HashSet<String> = recs.into_iter().map(|l| format!("m{}", l.id)).collect();
    CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(tmdb_id, (Instant::now(), ids.clone()));
    ids
}

/// A themed row: its title and the TMDB keyword it's made of.
struct Theme {
    title: &'static str,
    keyword: &'static str,
}

/// A holiday's row: shown from `from` through `to` (month, day), inclusive.
struct Holiday {
    theme: Theme,
    from: (u32, u32),
    to: (u32, u32),
}

const HOLIDAYS: &[Holiday] = &[
    Holiday {
        theme: Theme { title: "New Year's Eve", keyword: "new year's eve" },
        from: (12, 26),
        to: (12, 31),
    },
    Holiday {
        theme: Theme { title: "Valentine's Day", keyword: "valentine's day" },
        from: (2, 1),
        to: (2, 14),
    },
    Holiday { theme: Theme { title: "Summer", keyword: "summer" }, from: (6, 15), to: (8, 31) },
    Holiday { theme: Theme { title: "Halloween", keyword: "halloween" }, from: (10, 1), to: (10, 31) },
    Holiday { theme: Theme { title: "Thanksgiving", keyword: "thanksgiving" }, from: (11, 1), to: (11, 30) },
    Holiday { theme: Theme { title: "Christmas", keyword: "christmas" }, from: (11, 15), to: (12, 31) },
];

/// Rotating themes: two a day.
const THEMES: &[Theme] = &[
    Theme { title: "Heists", keyword: "heist" },
    Theme { title: "Time travel", keyword: "time travel" },
    Theme { title: "Based on a true story", keyword: "based on true story" },
    Theme { title: "Superheroes", keyword: "superhero" },
    Theme { title: "Road trips", keyword: "road trip" },
    Theme { title: "Dystopian futures", keyword: "dystopia" },
    Theme { title: "Survival", keyword: "survival" },
    Theme { title: "Coming of age", keyword: "coming of age" },
    Theme { title: "Space", keyword: "space" },
    Theme { title: "Sports", keyword: "sports" },
];
const THEMES_PER_DAY: usize = 2;

/// Holidays in season on this date (month, day).
fn holidays_on(month: u32, day: u32) -> impl Iterator<Item = &'static Theme> {
    HOLIDAYS.iter().filter(move |h| (month, day) >= h.from && (month, day) <= h.to).map(|h| &h.theme)
}

/// Titles tagged with a keyword, most popular first: (movies, shows).
type Tagged = (Vec<Listing>, Vec<Listing>);
/// Per keyword: when it was looked up and what it found (`None`: being looked up).
type KeywordCache = Mutex<HashMap<&'static str, (Instant, Option<Tagged>)>>;
static KEYWORDS: LazyLock<KeywordCache> = LazyLock::new(Default::default);
const KEYWORD_TTL: Duration = Duration::from_secs(86_400);
/// Pages of TMDB results per keyword (20 each): movies, shows.
const MOVIE_PAGES: u32 = 15;
const SHOW_PAGES: u32 = 3;

/// What's cached for a keyword; a missing or stale entry starts a lookup in the background.
fn tagged(state: &AppState, keyword: &'static str) -> Option<Tagged> {
    let mut cache = KEYWORDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let entry = cache.get(keyword);
    let fresh = entry.is_some_and(|(at, _)| at.elapsed() < KEYWORD_TTL);
    let value = entry.and_then(|(_, v)| v.clone());
    if !fresh {
        // Keep serving the old value (if any) while the new one is fetched.
        cache.insert(keyword, (Instant::now(), value.clone()));
        let state = state.clone();
        tokio::spawn(async move {
            let found = lookup(&state, keyword).await;
            let mut cache = KEYWORDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match found {
                Some(found) => {
                    cache.insert(keyword, (Instant::now(), Some(found)));
                }
                // Failed: try again on a later request.
                None => {
                    cache.remove(keyword);
                }
            }
        });
    }
    value
}

/// How often the holiday and theme lookups are refreshed in the background.
const WARM_EVERY: Duration = Duration::from_secs(12 * 3600);

/// Look up today's holidays and every theme when the server starts (and twice a day after), one
/// at a time, so the rows are there on the first visit instead of the one after.
pub(crate) fn spawn_warmup(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(WARM_EVERY);
        loop {
            tick.tick().await;
            if state.integrations().tmdb.is_none() {
                continue;
            }
            let today = chrono::Local::now().date_naive();
            let keywords = holidays_on(today.month(), today.day()).chain(THEMES.iter()).map(|t| t.keyword);
            let (mut ok, mut failed) = (0, 0);
            for keyword in keywords {
                let Some(found) = lookup(&state, keyword).await else {
                    failed += 1;
                    continue;
                };
                ok += 1;
                {
                    KEYWORDS
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(keyword, (Instant::now(), Some(found)));
                }
            }
            tracing::info!(ok, failed, "home themes looked up");
        }
    });
}

async fn lookup(state: &AppState, keyword: &str) -> Option<Tagged> {
    let tmdb = state.integrations().tmdb.clone()?;
    let Some(id) = tmdb.keyword_id(keyword).await.ok()? else {
        tracing::info!(keyword, "no such TMDB keyword");
        return Some((Vec::new(), Vec::new()));
    };
    let mut movies = Vec::new();
    for page in 1..=MOVIE_PAGES {
        let found = tmdb.with_keyword(true, id, page).await.ok()?;
        let done = found.len() < 20;
        movies.extend(found);
        if done {
            break;
        }
    }
    let mut shows = Vec::new();
    for page in 1..=SHOW_PAGES {
        let found = tmdb.with_keyword(false, id, page).await.ok()?;
        let done = found.len() < 20;
        shows.extend(found);
        if done {
            break;
        }
    }
    Some((movies, shows))
}

/// Requestable titles per themed row, at most.
const THEME_MORE: usize = 10;
/// How many of a keyword's popular titles (not in the library) are considered for that.
const MORE_CANDIDATES: usize = 30;
/// Posters for those may take this long; the rest show next time.
const POSTER_WAIT: Duration = Duration::from_secs(3);

async fn themed_rows(
    state: &AppState,
    user_id: i64,
    movies: &[Title],
    shows: &[SeriesSummary],
    seed: u64,
) -> ApiResult<Vec<ThemedRow>> {
    let Some(tmdb) = state.integrations().tmdb.clone() else { return Ok(Vec::new()) };
    let today = chrono::Local::now().date_naive();
    let mut themes: Vec<(&'static Theme, bool)> =
        holidays_on(today.month(), today.day()).map(|t| (t, true)).collect();
    let mut rotating: Vec<&'static Theme> = THEMES.iter().collect();
    Rng::new(seed ^ 0x7e3e).shuffle(&mut rotating);
    themes.extend(rotating.into_iter().map(|t| (t, false)));

    let movie_by_tmdb: HashMap<i64, &Title> =
        movies.iter().filter_map(|m| Some((m.id.strip_prefix('m')?.parse().ok()?, m))).collect();
    let show_by_tmdb: HashMap<i64, &SeriesSummary> =
        shows.iter().filter_map(|s| Some((s.tmdb_id?, s))).collect();

    let mut out = Vec::new();
    let mut rotating_shown = 0;
    for (theme, seasonal) in themes {
        if !seasonal && rotating_shown == THEMES_PER_DAY {
            break;
        }
        let Some((m, s)) = tagged(state, theme.keyword) else { continue };
        let mut items: Vec<Spot> = m
            .iter()
            .filter_map(|l| movie_by_tmdb.get(&l.id))
            .map(|t| movie_spot(t, "Unwatched", None))
            .collect();
        items.extend(s.iter().filter_map(|l| show_by_tmdb.get(&l.id)).map(|x| show_spot(x, "Unwatched")));
        items.truncate(THEME_MAX);

        // Then the popular ones you don't have (movies and shows alternating), when they can be
        // requested or are already on their way.
        let missing_movies = m.iter().filter(|l| !movie_by_tmdb.contains_key(&l.id));
        let missing_shows = s.iter().filter(|l| !show_by_tmdb.contains_key(&l.id));
        let mut candidates: Vec<&Listing> = Vec::new();
        let (mut mi, mut si) = (missing_movies.fuse(), missing_shows.fuse());
        while candidates.len() < MORE_CANDIDATES {
            let (a, b) = (mi.next(), si.next());
            if a.is_none() && b.is_none() {
                break;
            }
            candidates.extend(a.into_iter().chain(b));
        }
        let paths: HashMap<i64, Option<String>> =
            candidates.iter().map(|l| (l.id, l.poster_path.clone())).collect();
        let mut more: Vec<Discover> =
            for_profile(state, user_id, candidates.iter().map(|l| to_discover(l)).collect())
                .await?
                .into_iter()
                .filter(|d| d.can_request || d.requested || d.downloaded)
                .take(THEME_MORE)
                .collect();
        let posters = futures_util::future::join_all(more.iter().map(|d| {
            let path = paths.get(&d.tmdb_id).cloned().flatten();
            let (tmdb, images) = (tmdb.clone(), state.images.clone());
            async move {
                let path = path?;
                tokio::time::timeout(POSTER_WAIT, images.fetch(&tmdb, ImageSize::Poster, &path))
                    .await
                    .ok()?
                    .ok()?
            }
        }))
        .await;
        for (d, poster) in more.iter_mut().zip(posters) {
            d.poster = poster;
        }

        if items.len() + more.len() < THEME_MIN {
            continue;
        }
        if !seasonal {
            rotating_shown += 1;
        }
        out.push(ThemedRow { title: theme.title, seasonal, items, more });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holidays_come_in_season() {
        let names = |m, d| holidays_on(m, d).map(|t| t.title).collect::<Vec<_>>();
        assert_eq!(names(11, 21), ["Thanksgiving", "Christmas"]);
        assert_eq!(names(12, 28), ["New Year's Eve", "Christmas"]);
        assert_eq!(names(10, 31), ["Halloween"]);
        assert!(names(3, 10).is_empty());
    }
}
