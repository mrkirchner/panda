//! Watch progress, Continue Watching and the home screen.

use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use panda_db::{Item, ItemFilter, ItemKind, SeriesSummary, WatchState};
use serde::{Deserialize, Serialize};

use super::featured::{self, Featured, FeaturedSeries, Pick};
use super::titles::{Title, movie_titles};
use crate::auth::middleware::MediaGrant;
use crate::auth::{self, CurrentUser, allowed_libraries, ensure_item_access, with_token};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::now;
use crate::state::AppState;

const CONTINUE_LIMIT: usize = 20;
/// Watch states looked at for Continue Watching, most recent first (plenty for 20 entries).
const CONTINUE_SCAN: usize = 200;
const ROW_LIMIT: usize = 20;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/progress", post(record))
        .route("/watched", post(watched))
        .route("/home", get(home))
        .route("/auth/topshelf-token", post(top_shelf_token))
}

/// Signed (`?t=`) routes: the Apple TV Top Shelf extension, which has no session.
pub(super) fn media_routes() -> Router<AppState> {
    Router::new().route("/topshelf/items", get(top_shelf))
}

/// What progress is keyed by: the movie or episode, not the file. So it carries across
/// versions and survives Radarr/Sonarr replacing a file.
pub(crate) fn watch_key(item: &Item) -> String {
    match (item.kind.as_str(), item.tmdb_id, item.season, item.episode) {
        ("movie", Some(t), ..) => format!("m{t}"),
        ("episode", Some(t), Some(s), Some(e)) => format!("s{t}e{s}x{e}"),
        _ => format!("i{}", item.id),
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Progress {
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub finished: bool,
    /// 0.0-1.0, for progress bars.
    pub fraction: f64,
    pub last_played_at: i64,
}

impl From<&WatchState> for Progress {
    fn from(s: &WatchState) -> Self {
        Self {
            position_secs: s.position_secs,
            duration_secs: s.duration_secs,
            finished: s.finished,
            fraction: s.fraction(),
            last_played_at: s.last_played_at,
        }
    }
}

pub(crate) async fn states_by_key(state: &AppState, user_id: i64) -> ApiResult<HashMap<String, WatchState>> {
    Ok(state.db.watch_states(user_id).await?.into_iter().map(|s| (s.watch_key.clone(), s)).collect())
}

#[derive(Deserialize)]
struct ProgressBody {
    item_id: i64,
    position_secs: f64,
    duration_secs: Option<f64>,
}

/// Players report their position every ~10 s and when stopping.
async fn record(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<ProgressBody>,
) -> ApiResult<Json<Progress>> {
    if !body.position_secs.is_finite() || body.position_secs < 0.0 {
        return Err(ApiError::Validation("position_secs must be a non-negative number".into()));
    }
    let item = state.db.item(body.item_id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, me.user.id, &item).await?;
    let duration = body.duration_secs.filter(|d| d.is_finite() && *d > 0.0).or(item.duration_secs);
    let s = state
        .db
        .record_progress(me.user.id, &watch_key(&item), item.id, body.position_secs, duration, now())
        .await?;
    Ok(Json(Progress::from(&s)))
}

#[derive(Deserialize)]
struct WatchedBody {
    item_id: i64,
    watched: bool,
}

async fn watched(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<WatchedBody>,
) -> ApiResult<StatusCode> {
    let item = state.db.item(body.item_id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, me.user.id, &item).await?;
    state.db.set_watched(me.user.id, &watch_key(&item), item.id, body.watched, now()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct ContinueEntry {
    kind: String,
    item_id: i64,
    /// Movies: the title to open. Episodes: none (open the series).
    title_id: Option<String>,
    series: Option<String>,
    /// Movie title or series name.
    title: String,
    /// "S2 E5  Episode name" / year.
    subtitle: String,
    poster: Option<String>,
    backdrop: Option<String>,
    position_secs: f64,
    duration_secs: Option<f64>,
    fraction: f64,
    /// The next episode after one you finished (start from the beginning).
    up_next: bool,
    last_played_at: i64,
}

#[derive(Debug, Serialize)]
struct Home {
    featured: Vec<Featured>,
    continue_watching: Vec<ContinueEntry>,
    my_list: Vec<super::favorites::MyListEntry>,
    recently_added_movies: Vec<Title>,
    recently_added_shows: Vec<SeriesSummary>,
}

fn episode_subtitle(i: &Item) -> String {
    let name = i.episode_title.clone().unwrap_or_default();
    format!("S{} E{}  {}", i.season.unwrap_or(0), i.episode.unwrap_or(0), name).trim().to_string()
}

fn entry(i: &Item, s: Option<&WatchState>, up_next: bool, at: i64) -> ContinueEntry {
    let movie = i.kind == "movie";
    ContinueEntry {
        kind: i.kind.clone(),
        item_id: i.id,
        title_id: movie.then(|| i.tmdb_id.map_or_else(|| format!("i{}", i.id), |t| format!("m{t}"))),
        series: i.series.clone(),
        title: i.meta_title.clone().unwrap_or_else(|| i.series.clone().unwrap_or_else(|| i.title.clone())),
        subtitle: if movie { i.year.map(|y| y.to_string()).unwrap_or_default() } else { episode_subtitle(i) },
        poster: i.poster.clone(),
        backdrop: i.backdrop.clone(),
        position_secs: s.map_or(0.0, |s| s.position_secs),
        duration_secs: s.and_then(|s| s.duration_secs).or(i.duration_secs),
        fraction: s.map_or(0.0, WatchState::fraction),
        up_next,
        last_played_at: at,
    }
}

/// In-progress titles, plus the next episode of shows whose latest episode you finished.
/// One entry per show, most recent first.
async fn continue_watching(state: &AppState, user_id: i64) -> ApiResult<Vec<ContinueEntry>> {
    let states = state.db.watch_states(user_id).await?;
    let by_key: HashMap<&str, &WatchState> = states.iter().map(|s| (s.watch_key.as_str(), s)).collect();
    let allowed = allowed_libraries(state, user_id).await?;
    let mut out: Vec<ContinueEntry> = Vec::new();
    let mut seen_series: Vec<String> = Vec::new();

    // Only the most recent states can make the row; their items in one query (not one each).
    let recent = &states[..states.len().min(CONTINUE_SCAN)];
    let ids: Vec<i64> = recent.iter().map(|s| s.item_id).collect();
    let items: HashMap<i64, Item> =
        state.db.items_by_ids(&ids).await?.into_iter().map(|i| (i.id, i)).collect();

    for s in recent {
        if out.len() >= CONTINUE_LIMIT {
            break;
        }
        // A file replaced since (a Radarr/Sonarr upgrade is a new item): its title's current one.
        let item = match items.get(&s.item_id) {
            Some(i) => i.clone(),
            None => match state.db.item_for_watch_key(&s.watch_key).await? {
                Some(i) => i,
                None => continue,
            },
        };
        if allowed.as_ref().is_some_and(|a| !a.contains(&item.library_id)) {
            continue;
        }
        if let Some(series) = &item.series {
            // One entry per show, even across its folders (spelled differently, same TMDB show).
            let show = item.tmdb_id.map_or_else(|| series.to_lowercase(), |t| format!("t{t}"));
            if seen_series.contains(&show) {
                continue;
            }
            seen_series.push(show);
        }
        if s.in_progress() {
            out.push(entry(&item, Some(s), false, s.last_played_at));
        } else if s.finished && item.kind == "episode" {
            // Up next: the first later episode not yet finished.
            let filter = ItemFilter {
                series: item.series.clone(),
                kind: Some(ItemKind::Episode),
                allowed_libraries: allowed.clone(),
                limit: Some(10_000),
                ..Default::default()
            };
            let here = (item.season.unwrap_or(0), item.episode.unwrap_or(0));
            let next = state.db.items(&filter).await?.into_iter().find(|e| {
                (e.season.unwrap_or(0), e.episode.unwrap_or(0)) > here
                    && !by_key.get(watch_key(e).as_str()).is_some_and(|w| w.finished)
            });
            if let Some(next) = next {
                out.push(entry(
                    &next,
                    by_key.get(watch_key(&next).as_str()).copied(),
                    true,
                    s.last_played_at,
                ));
            }
        }
    }
    Ok(out)
}

/// Calendar year of a Unix time (UTC), for "new release". Civil-from-days (H. Hinnant).
pub(super) fn year_of(secs: i64) -> i64 {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    yoe + era * 400 + i64::from(month <= 2)
}

async fn home(State(state): State<AppState>, Extension(me): Extension<CurrentUser>) -> ApiResult<Json<Home>> {
    let mut movies = movie_titles(&state, me.user.id, None).await?;
    movies.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    let allowed = allowed_libraries(&state, me.user.id).await?;
    let mut shows: Vec<SeriesSummary> = crate::catalog::series(&state, allowed.as_deref()).await?;
    shows.sort_by(|a, b| b.latest_added_at.cmp(&a.latest_added_at));

    // Hero: picked from the whole library, before the rows are cut down.
    let t = now();
    let picks = featured::pick(&movies, &shows, year_of(t), featured::daily_seed(t, me.user.id));
    let watched: HashMap<String, WatchState> =
        state.db.watch_states(me.user.id).await?.into_iter().map(|w| (w.watch_key.clone(), w)).collect();
    let mut hero = Vec::with_capacity(picks.len());
    for (reason, p) in picks {
        hero.push(match p {
            Pick::Movie(i) => Featured {
                reason,
                movie: Some(movies[i].clone()),
                series: None,
                logo: None,
                ratings: Vec::new(),
            },
            Pick::Show(i) => {
                let summary = shows[i].clone();
                let next = featured::next_episode(&state, &summary.series, allowed.clone(), &watched).await?;
                Featured {
                    reason,
                    movie: None,
                    series: Some(FeaturedSeries { summary, next }),
                    logo: None,
                    ratings: Vec::new(),
                }
            }
        });
    }
    add_hero_extras(&state, &mut hero).await;

    shows.truncate(ROW_LIMIT);
    movies.truncate(ROW_LIMIT);
    Ok(Json(Home {
        featured: hero,
        continue_watching: continue_watching(&state, me.user.id).await?,
        my_list: super::favorites::my_list(&state, me.user.id).await?,
        recently_added_movies: movies,
        recently_added_shows: shows,
    }))
}

/// Each slide's logo and ratings, like a title's page. Logos already known only: a missing one
/// is looked up in the background (for next time) rather than holding up Home.
async fn add_hero_extras(state: &AppState, hero: &mut [Featured]) {
    use panda_db::MetadataKind;
    let tmdb_of = |f: &Featured| -> Option<(MetadataKind, i64, Option<f64>)> {
        if let Some(m) = &f.movie {
            let id = m.id.strip_prefix('m')?.parse().ok()?;
            return Some((MetadataKind::Movie, id, m.rating));
        }
        let s = f.series.as_ref()?;
        Some((MetadataKind::Series, s.summary.tmdb_id?, s.summary.rating))
    };
    let ids = |k: MetadataKind| -> Vec<i64> {
        hero.iter().filter_map(tmdb_of).filter(|(kind, ..)| *kind == k).map(|(_, id, _)| id).collect()
    };
    let (movie_ids, show_ids) = (ids(MetadataKind::Movie), ids(MetadataKind::Series));
    let quick = |kind: &'static str, mk: MetadataKind, ids: Vec<i64>| async move {
        // `logos_for` answers at once for known logos; unknown ones keep downloading after this.
        tokio::time::timeout(HERO_LOGO_WAIT, super::home_more::logos_for(state, kind, mk, &ids))
            .await
            .unwrap_or_default()
    };
    let (movie_logos, show_logos) = tokio::join!(
        quick("movie", MetadataKind::Movie, movie_ids),
        quick("series", MetadataKind::Series, show_ids),
    );
    for f in hero.iter_mut() {
        let Some((kind, id, score)) = tmdb_of(f) else { continue };
        let logos = if kind == MetadataKind::Movie { &movie_logos } else { &show_logos };
        f.logo = logos.get(&id).cloned().flatten();
        f.ratings = crate::services::providers::ratings(state, kind, id, score).await;
    }
}

/// How long Home waits for hero logos (known ones come at once).
const HERO_LOGO_WAIT: std::time::Duration = std::time::Duration::from_millis(400);

/// Items per Top Shelf row (tvOS shows a handful; more only costs the extension time).
const SHELF_LIMIT: usize = 12;

#[derive(Serialize)]
struct ShelfToken {
    token: String,
    /// Unix seconds.
    expires_at: u64,
}

/// A token for the Apple TV Top Shelf extension (read-only, `/api/topshelf/` only, 7 days),
/// for the signed-in profile. The app asks for one each time it runs.
async fn top_shelf_token(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> Json<ShelfToken> {
    let (token, expires_at) = auth::top_shelf_token(&state, (&me.user).into());
    Json(ShelfToken { token, expires_at })
}

#[derive(Serialize)]
struct Shelf {
    sections: Vec<ShelfSection>,
}

#[derive(Serialize)]
struct ShelfSection {
    title: &'static str,
    /// "hdtv" (16:9) or "poster" (2:3).
    shape: &'static str,
    items: Vec<ShelfItem>,
}

#[derive(Serialize)]
struct ShelfItem {
    id: String,
    title: String,
    /// Signed artwork path.
    image: Option<String>,
    progress: Option<f64>,
    /// App path to open (`title/m1`, `series/Name`), and to play when there's a direct way.
    open: String,
    play: Option<String>,
}

/// Percent-encode one path segment or query value (show names in app paths).
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The Top Shelf's rows: Continue Watching and Recently Added (movies and shows together).
async fn top_shelf(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
) -> ApiResult<Json<Shelf>> {
    let user_id = grant.user_id;
    let image_token = auth::image_token(&state, (&grant).into());
    let image = |key: Option<&String>| key.map(|k| with_token(&format!("/api/images/{k}"), &image_token));

    let continuing = continue_watching(&state, user_id)
        .await?
        .into_iter()
        .take(SHELF_LIMIT)
        .map(|c| {
            let page = match (&c.title_id, &c.series) {
                (Some(id), _) => format!("title/{}", encode(id)),
                (None, Some(series)) => format!("series/{}", encode(series)),
                _ => String::new(),
            };
            let start = if c.up_next { 0.0 } else { c.position_secs };
            let back = if page.is_empty() { String::new() } else { format!("&back=/{}", encode(&page)) };
            let play = match &c.title_id {
                Some(id) => format!("play/title/{}?start={start:.0}{back}", encode(id)),
                None => format!("play/item/{}?start={start:.0}{back}", c.item_id),
            };
            let title =
                if c.series.is_some() { format!("{}: {}", c.title, c.subtitle) } else { c.title.clone() };
            ShelfItem {
                id: format!("c{}", c.item_id),
                title,
                image: image(c.backdrop.as_ref().or(c.poster.as_ref())),
                progress: (!c.up_next).then_some(c.fraction),
                open: if page.is_empty() { play.clone() } else { page },
                play: Some(play),
            }
        })
        .collect();

    // Newest first, movies and shows mixed.
    let movies = movie_titles(&state, user_id, None).await?;
    let allowed = allowed_libraries(&state, user_id).await?;
    let shows: Vec<SeriesSummary> = crate::catalog::series(&state, allowed.as_deref()).await?;
    let mut recent: Vec<(String, ShelfItem)> = movies
        .iter()
        .map(|t| {
            (
                t.added_at.clone(),
                ShelfItem {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    image: image(t.poster.as_ref()),
                    progress: None,
                    open: format!("title/{}", encode(&t.id)),
                    play: Some(format!("play/title/{}?back=/title/{}", encode(&t.id), encode(&t.id))),
                },
            )
        })
        .chain(shows.iter().map(|s| {
            (
                s.latest_added_at.clone(),
                ShelfItem {
                    id: format!("s:{}", s.series),
                    title: s.meta_title.clone().unwrap_or_else(|| s.series.clone()),
                    image: image(s.poster.as_ref()),
                    progress: None,
                    open: format!("series/{}", encode(&s.series)),
                    play: None,
                },
            )
        }))
        .collect();
    recent.sort_by(|a, b| b.0.cmp(&a.0));
    let recent = recent.into_iter().take(SHELF_LIMIT).map(|(_, i)| i).collect();

    Ok(Json(Shelf {
        sections: vec![
            ShelfSection { title: "Continue Watching", shape: "hdtv", items: continuing },
            ShelfSection { title: "Recently Added", shape: "poster", items: recent },
        ],
    }))
}

#[cfg(test)]
mod shelf_tests {
    use super::encode;

    #[test]
    fn encodes_names_for_app_paths() {
        assert_eq!(encode("Black Doves"), "Black%20Doves");
        assert_eq!(encode("m123"), "m123");
        assert_eq!(encode("a/b?c&d"), "a%2Fb%3Fc%26d");
        assert_eq!(encode("Amélie"), "Am%C3%A9lie");
    }
}

#[cfg(test)]
mod year_tests {
    use super::year_of;

    #[test]
    fn year_of_unix_time() {
        assert_eq!(year_of(0), 1970);
        assert_eq!(year_of(951_782_400), 2000); // 2000-02-29
        assert_eq!(year_of(1_704_067_199), 2023); // 2023-12-31 23:59:59
        assert_eq!(year_of(1_704_067_200), 2024); // 2024-01-01
        assert_eq!(year_of(1_795_146_594), 2026);
    }
}
