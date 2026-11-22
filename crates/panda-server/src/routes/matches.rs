//! Fixing TMDB matches by hand (admin). Automatic matching goes by the file or folder name, which
//! sometimes picks the wrong movie or show (or none); a wrong match brings the wrong artwork,
//! overview and episode names.
//!
//! - `GET /api/admin/matches`: titles worth a look: unmatched ones, and matches whose title
//!   doesn't resemble the file/folder name (or whose year is off).
//! - `GET /api/admin/matches/search?kind=movie|series&q=`: TMDB's candidates, with posters.
//! - `POST /api/admin/matches {kind, id, tmdb_id}`: use that one. Scans never re-match a file
//!   that has a match, so the choice sticks.
//! - `GET /api/admin/matches/seasons?series=`: a show folder's seasons and their matches.
//! - `POST /api/admin/matches/season {series, season, tmdb_id, tmdb_season}` (and `DELETE` with
//!   `?series=&season=`): take one season's episodes from another TMDB show. Sonarr keeps
//!   anthologies as one show with a season per story; TMDB lists each story as its own show.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use panda_db::{ItemFilter, ItemKind};
use panda_metadata::ImageSize;
use panda_metadata::matching::{self, normalize};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::metadata;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/matches", get(suspects).post(apply))
        .route("/matches/search", get(search))
        .route("/matches/seasons", get(seasons))
        .route("/matches/season", axum::routing::post(apply_season).delete(clear_season))
        .route("/matches/episode-order", get(episode_orders).put(set_episode_order))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Movie,
    Series,
}

#[derive(Serialize)]
struct Matched {
    tmdb_id: i64,
    title: String,
    year: Option<i64>,
    /// Cached poster key (`/api/images/{key}`).
    poster: Option<String>,
}

#[derive(Serialize)]
struct Suspect {
    kind: Kind,
    /// What to send back to fix it: a title id (`m603`, `i42`) or a show's name.
    id: String,
    /// The name Panda matched from (file or folder).
    name: String,
    year: Option<i64>,
    /// `None`: not matched at all.
    matched: Option<Matched>,
    /// Why it's listed.
    reason: &'static str,
}

/// How alike two titles are, from their words (0 = nothing shared, 1 = the same words).
fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (normalize(a), normalize(b));
    if a == b || (!a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))) {
        return 1.0;
    }
    let wa: std::collections::HashSet<&str> =
        a.split_whitespace().filter(|w| *w != "the" && *w != "a").collect();
    let wb: std::collections::HashSet<&str> =
        b.split_whitespace().filter(|w| *w != "the" && *w != "a").collect();
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let ratio = wa.intersection(&wb).count() as f64 / wa.union(&wb).count() as f64;
    ratio
}

/// Why a match looks wrong, if it does.
fn doubt(
    name: &str,
    year: Option<i64>,
    matched_title: &str,
    matched_year: Option<i64>,
) -> Option<&'static str> {
    if similarity(name, matched_title) < 0.5 {
        return Some("different title");
    }
    match (year, matched_year) {
        (Some(a), Some(b)) if (a - b).abs() > 1 => Some("different year"),
        _ => None,
    }
}

async fn suspects(State(state): State<AppState>) -> ApiResult<Json<Vec<Suspect>>> {
    let mut out = Vec::new();

    // Movies: one entry per title (its versions share a match).
    let filter = ItemFilter { kind: Some(ItemKind::Movie), limit: Some(10_000), ..Default::default() };
    let mut seen = std::collections::HashSet::new();
    for i in state.db.items(&filter).await? {
        let id = i.tmdb_id.map_or_else(|| format!("i{}", i.id), |t| format!("m{t}"));
        if !seen.insert(id.clone()) {
            continue;
        }
        match (i.tmdb_id, &i.meta_title) {
            (Some(tmdb_id), Some(title)) => {
                // The matched year isn't on the item: the title's own year is the file's.
                if let Some(reason) = doubt(&i.title, i.year, title, None) {
                    out.push(Suspect {
                        kind: Kind::Movie,
                        id,
                        name: i.title.clone(),
                        year: i.year,
                        matched: Some(Matched {
                            tmdb_id,
                            title: title.clone(),
                            year: None,
                            poster: i.poster.clone(),
                        }),
                        reason,
                    });
                }
            }
            _ => out.push(Suspect {
                kind: Kind::Movie,
                id,
                name: i.title.clone(),
                year: i.year,
                matched: None,
                reason: "not matched",
            }),
        }
    }

    // Shows: each folder's name (and year, if it has one) against what it matched. Folder by
    // folder: two folders wrongly matched to one show would look like one show otherwise.
    for f in state.db.series_folders().await? {
        let matched = f.tmdb_id.zip(f.meta_title.clone()).map(|(tmdb_id, title)| Matched {
            tmdb_id,
            title,
            year: f.year,
            poster: f.poster.clone(),
        });
        let year = matching::folder_year(&f.series).map(i64::from);
        let reason = match &matched {
            None => Some("not matched"),
            Some(m) => doubt(&f.series, year, &m.title, m.year),
        };
        if let Some(reason) = reason {
            out.push(Suspect {
                kind: Kind::Series,
                id: f.series.clone(),
                name: f.series,
                year,
                matched,
                reason,
            });
        }
    }
    // Likely mismatches (wrong artwork) first; titles with no match at all after them.
    out.sort_by_key(|s| s.reason == "not matched");
    Ok(Json(out))
}

#[derive(Deserialize)]
struct SearchQuery {
    kind: Kind,
    q: String,
}

#[derive(Serialize)]
struct Candidate {
    tmdb_id: i64,
    title: String,
    year: Option<String>,
    overview: Option<String>,
    poster: Option<String>,
}

const CANDIDATES: usize = 12;

/// A TMDB search hit, movie or show.
struct Found {
    tmdb_id: i64,
    title: String,
    date: Option<String>,
    overview: Option<String>,
    poster_path: Option<String>,
}

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> ApiResult<Json<Vec<Candidate>>> {
    let tmdb =
        state.integrations().tmdb.clone().ok_or_else(|| ApiError::BadRequest("TMDB isn't set up".into()))?;
    let q = params.q.trim();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let found: Vec<Found> = match params.kind {
        Kind::Movie => tmdb
            .search_movie(q, None)
            .await
            .map_err(|e| ApiError::BadRequest(format!("TMDB search failed: {e}")))?
            .into_iter()
            .take(CANDIDATES)
            .map(|m| Found {
                tmdb_id: m.id,
                title: m.title,
                date: m.release_date,
                overview: m.overview,
                poster_path: m.poster_path,
            })
            .collect(),
        Kind::Series => tmdb
            .search_tv(q, None)
            .await
            .map_err(|e| ApiError::BadRequest(format!("TMDB search failed: {e}")))?
            .into_iter()
            .take(CANDIDATES)
            .map(|t| Found {
                tmdb_id: t.id,
                title: t.name,
                date: t.first_air_date,
                overview: t.overview,
                poster_path: t.poster_path,
            })
            .collect(),
    };
    let posters = futures_util::future::join_all(found.iter().map(|f| {
        let (tmdb, images) = (tmdb.clone(), state.images.clone());
        let path = f.poster_path.clone();
        async move {
            match path {
                Some(p) => images.fetch(&tmdb, ImageSize::Poster, &p).await.ok().flatten(),
                None => None,
            }
        }
    }))
    .await;
    Ok(Json(
        found
            .into_iter()
            .zip(posters)
            .map(|(f, poster)| Candidate {
                tmdb_id: f.tmdb_id,
                title: f.title,
                year: f.date.filter(|d| d.len() >= 4).map(|d| d[..4].to_string()),
                overview: f.overview.filter(|o| !o.is_empty()),
                poster,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct Apply {
    kind: Kind,
    /// A title id (movies) or a show's name.
    id: String,
    tmdb_id: i64,
}

async fn apply(State(state): State<AppState>, Json(body): Json<Apply>) -> ApiResult<StatusCode> {
    match body.kind {
        Kind::Movie => {
            let catalog = crate::catalog::get(&state).await?;
            let title = catalog.movies.iter().find(|c| c.title.id == body.id).ok_or(ApiError::NotFound)?;
            let ids: Vec<i64> = title.title.versions.iter().map(|v| v.item_id).collect();
            metadata::apply_movie(&state, &ids, body.tmdb_id)
                .await
                .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        }
        Kind::Series => {
            // Only this folder: another folder of the same name may rightly be a different show.
            let filter = ItemFilter {
                kind: Some(ItemKind::Episode),
                folder: Some(body.id.clone()),
                limit: Some(10_000),
                ..Default::default()
            };
            let items = state.db.items(&filter).await?;
            if items.is_empty() {
                return Err(ApiError::NotFound);
            }
            metadata::apply_series(&state, &items, body.tmdb_id)
                .await
                .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        }
    }
    tracing::info!(kind = ?body.kind, id = %body.id, tmdb_id = body.tmdb_id, "match fixed by hand");
    // The extra providers are asked about the new match now, not at the next scan.
    crate::services::providers::refresh_soon(&state);
    Ok(StatusCode::NO_CONTENT)
}

/// A show's episode order: the one chosen (its TMDB episode group id; `None`: TMDB's default
/// seasons) and the others TMDB has for the show.
#[derive(Serialize)]
struct EpisodeOrders {
    current: Option<String>,
    orders: Vec<OrderView>,
}

#[derive(Serialize)]
struct OrderView {
    id: String,
    name: String,
    /// "DVD", "Absolute", ...
    kind: &'static str,
    episodes: i64,
    seasons: i64,
}

async fn episode_orders(
    State(state): State<AppState>,
    Query(q): Query<FolderQuery>,
) -> ApiResult<Json<EpisodeOrders>> {
    let (meta_id, show, tmdb) = folder_show(&state, &q.series).await?;
    let current = metadata::show_episode_order(&state, meta_id, &q.series).await?;
    let orders = tmdb
        .episode_groups(show)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
        .into_iter()
        .map(|g| OrderView {
            kind: g.kind_label(),
            id: g.id,
            name: g.name,
            episodes: g.episode_count,
            seasons: g.group_count,
        })
        .collect();
    Ok(Json(EpisodeOrders { current, orders }))
}

#[derive(Deserialize)]
struct SetOrder {
    series: String,
    /// One of the show's episode orders; `None`: back to TMDB's default seasons.
    id: Option<String>,
}

/// Number a show's episodes by another of TMDB's episode orders (DVD, absolute, ...), or back
/// by its default seasons. It's the show's: every folder of it (an HD and a 4K one) follows.
/// The new episodes are fetched before anything stored is replaced, so a failed lookup changes
/// nothing. Seasons matched to another show (an anthology's story) are left alone.
async fn set_episode_order(
    State(state): State<AppState>,
    Json(body): Json<SetOrder>,
) -> ApiResult<StatusCode> {
    let (meta_id, show, tmdb) = folder_show(&state, &body.series).await?;
    // Every folder of the show, and the seasons with files that are its own.
    let mut folders: std::collections::BTreeSet<String> =
        state.db.metadata_folders(meta_id).await?.iter().map(|f| normalize(f)).collect();
    folders.insert(normalize(&body.series));
    let mut seasons: std::collections::BTreeSet<i64> =
        state.db.metadata_seasons(meta_id).await?.into_iter().collect();
    for f in &folders {
        for m in state.db.season_matches(f).await? {
            seasons.remove(&m.season);
        }
    }
    let name = match &body.id {
        Some(id) => {
            let groups = tmdb.episode_groups(show).await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
            let group = groups
                .into_iter()
                .find(|g| g.id == *id)
                .ok_or_else(|| ApiError::BadRequest("That isn't one of this show's episode orders".into()))?;
            // Fetched first: if TMDB doesn't answer, nothing is changed.
            metadata::ordered_episodes(&tmdb, id, &seasons)
                .await
                .map_err(|e| ApiError::BadRequest(format!("TMDB didn't send that order: {e}")))?;
            Some(group.name)
        }
        None => None,
    };
    let now = crate::services::settings::now();
    for f in &folders {
        match (&body.id, &name) {
            (Some(id), Some(name)) => state.db.set_episode_order(f, id, name, now).await?,
            _ => state.db.clear_episode_order(f).await?,
        }
    }
    for &s in &seasons {
        state.db.clear_season_episodes(meta_id, s).await?;
    }
    metadata::store_episodes(&state, &tmdb, show, meta_id, &body.series, &seasons)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    crate::services::providers::refresh_soon(&state);
    tracing::info!(series = %body.series, order = ?body.id, "episode order set by hand");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct FolderQuery {
    series: String,
}

#[derive(Serialize)]
struct SeasonRow {
    season: i64,
    episodes: usize,
    /// Taken from another TMDB show, if matched by hand.
    matched: Option<panda_db::SeasonMatch>,
    /// With an episode order chosen: the name of the order's part numbered as this season
    /// ("Season 1", "Specials", ...), so a mismatch shows.
    order_part: Option<String>,
}

async fn seasons(
    State(state): State<AppState>,
    Query(q): Query<FolderQuery>,
) -> ApiResult<Json<Vec<SeasonRow>>> {
    let filter = ItemFilter {
        kind: Some(ItemKind::Episode),
        folder: Some(q.series.clone()),
        limit: Some(10_000),
        ..Default::default()
    };
    let mut counts = std::collections::BTreeMap::<i64, usize>::new();
    for i in state.db.items(&filter).await? {
        *counts.entry(i.season.unwrap_or(0)).or_default() += 1;
    }
    let mut matched = state.db.season_matches(&normalize(&q.series)).await?;
    // With an episode order chosen: the name of its part for each season (best effort).
    let mut parts = std::collections::HashMap::<i64, String>::new();
    if let Ok((meta_id, _, tmdb)) = folder_show(&state, &q.series).await
        && let Some(order) = metadata::show_episode_order(&state, meta_id, &q.series).await?
        && let Ok(g) = tmdb.episode_group(&order).await
    {
        parts.extend(g.groups.iter().map(|p| (g.season_of(p), p.name.clone())));
    }
    Ok(Json(
        counts
            .into_iter()
            .map(|(season, episodes)| SeasonRow {
                season,
                episodes,
                matched: matched.iter().position(|m| m.season == season).map(|i| matched.swap_remove(i)),
                order_part: parts.remove(&season),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct ApplySeason {
    /// The show folder.
    series: String,
    season: i64,
    tmdb_id: i64,
    /// That show's season (a miniseries: 1).
    #[serde(default = "first_season")]
    tmdb_season: i64,
}

const fn first_season() -> i64 {
    1
}

/// The folder's show (metadata id, TMDB id) and TMDB, or why a season can't be matched yet.
async fn folder_show(
    state: &AppState,
    folder: &str,
) -> ApiResult<(i64, i64, std::sync::Arc<panda_metadata::Tmdb>)> {
    let tmdb =
        state.integrations().tmdb.clone().ok_or_else(|| ApiError::BadRequest("TMDB isn't set up".into()))?;
    let (meta_id, show) = state
        .db
        .folder_show(folder)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Match the show first, then its seasons".into()))?;
    Ok((meta_id, show, tmdb))
}

async fn apply_season(State(state): State<AppState>, Json(body): Json<ApplySeason>) -> ApiResult<StatusCode> {
    if body.season < 0 || body.tmdb_season < 0 {
        return Err(ApiError::BadRequest("Seasons start at 0".into()));
    }
    let (meta_id, show, tmdb) = folder_show(&state, &body.series).await?;
    let details = tmdb.tv(body.tmdb_id).await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
    // A miniseries (an anthology's story) has one season: that's the one, whatever was asked.
    let tmdb_season = if details.number_of_seasons == Some(1) { 1 } else { body.tmdb_season };
    // That season must exist before anything is saved.
    let has_episodes = tmdb.season(body.tmdb_id, tmdb_season).await.is_ok_and(|s| !s.episodes.is_empty());
    if !has_episodes {
        let count = details.number_of_seasons.map_or_else(String::new, |n| format!(" (it has {n})"));
        return Err(ApiError::BadRequest(format!(
            "\"{}\" has no season {tmdb_season} on TMDB{count}",
            details.name
        )));
    }
    let source = metadata::series_metadata(&tmdb, &state.images, body.tmdb_id)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
        .meta;
    let m = panda_db::SeasonMatch {
        folder: normalize(&body.series),
        season: body.season,
        tmdb_id: body.tmdb_id,
        tmdb_season,
        title: source.title,
        poster: source.poster,
        backdrop: source.backdrop,
        overview: source.overview,
        year: source.year,
    };
    state.db.set_season_match(&m, crate::services::settings::now()).await?;
    metadata::store_episodes(&state, &tmdb, show, meta_id, &body.series, &[body.season].into())
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    crate::services::providers::refresh_soon(&state);
    tracing::info!(series = %body.series, season = body.season, tmdb_id = body.tmdb_id, "season matched by hand");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ClearSeason {
    series: String,
    season: i64,
}

/// Back to the show's own season (its episodes are fetched again).
async fn clear_season(State(state): State<AppState>, Query(q): Query<ClearSeason>) -> ApiResult<StatusCode> {
    if !state.db.delete_season_match(&normalize(&q.series), q.season).await? {
        return Err(ApiError::NotFound);
    }
    if let Ok((meta_id, show, tmdb)) = folder_show(&state, &q.series).await {
        state.db.clear_season_episodes(meta_id, q.season).await?;
        metadata::store_episodes(&state, &tmdb, show, meta_id, &q.series, &[q.season].into())
            .await
            .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        crate::services::providers::refresh_soon(&state);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_matches_that_dont_look_like_the_file() {
        assert_eq!(doubt("The Legend of Korra", None, "The Legend of Korra", None), None);
        assert_eq!(doubt("Legend of Korra", None, "The Legend of Korra", None), None);
        assert_eq!(doubt("Amelie", None, "Amélie", None), None);
        assert_eq!(doubt("The Office (US)", None, "The Office", None), None);
        assert_eq!(doubt("Black Doves", None, "Doves", None), None, "contained");
        assert_eq!(doubt("Damages", None, "The Damned", None), Some("different title"));
        assert_eq!(doubt("Heat", Some(1995), "Heat", Some(1986)), Some("different year"));
        assert_eq!(doubt("Heat", Some(1995), "Heat", Some(1996)), None, "release years vary a year");
        assert_eq!(
            doubt("Monster (2022)", Some(2022), "Monster", Some(2004)),
            Some("different year"),
            "a folder's year"
        );
    }
}
