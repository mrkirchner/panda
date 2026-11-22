//! Titles: what people browse. A movie that exists as several files (4K + HD, different
//! folders of one library) is one title with several versions. Playing a title picks the
//! version this device can play most cheaply (see `panda_media::playback::choose_version`).

use std::collections::{BTreeMap, HashMap};

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use panda_db::Item;
use panda_media::playback;
use panda_media::probe::MediaInfo;
use serde::{Deserialize, Serialize};

use super::playback::{PlaybackRequest, PlaybackResponse, load, play};
use crate::auth::{CurrentUser, allowed_libraries};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/titles", get(list_titles))
        .route("/titles/{id}", get(get_title))
        .route("/titles/{id}/playback", post(play_title))
        .route("/titles/{id}/related", get(related_titles))
        .route("/titles/{id}/details", get(title_details))
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Version {
    pub item_id: i64,
    /// "4K Dolby Vision", "1080p", ...
    pub label: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub dynamic_range: Option<String>,
    pub video_codec: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[allow(clippy::struct_field_names)] // `title.title` is the natural JSON shape for clients.
pub(crate) struct Title {
    /// `m<tmdb id>` for matched movies, `i<item id>` otherwise.
    pub id: String,
    pub kind: &'static str,
    pub library_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub genres: Option<String>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub duration_secs: Option<f64>,
    /// Newest version's add time (RFC 3339).
    pub added_at: String,
    /// Best first (highest resolution).
    pub versions: Vec<Version>,
    /// The signed-in user's progress (most recent across versions).
    pub progress: Option<super::watch::Progress>,
}

fn version_label(i: &Item) -> String {
    let w = i.width.unwrap_or(0).max(i.height.unwrap_or(0) * 16 / 9);
    let res = match w {
        w if w >= 3200 => "4K",
        w if w >= 2400 => "1440p",
        w if w >= 1700 => "1080p",
        w if w >= 1100 => "720p",
        0 => "Unknown",
        _ => "SD",
    };
    let hdr = match i.dynamic_range.as_deref() {
        Some("dolbyvision") => " Dolby Vision",
        Some("hdr10") => " HDR10",
        Some("hlg") => " HLG",
        _ => "",
    };
    format!("{res}{hdr}")
}

/// Group movie items into titles: by TMDB id, else by (title, year).
pub(crate) fn group_movies(items: Vec<Item>) -> Vec<Title> {
    let mut groups: BTreeMap<String, Vec<Item>> = BTreeMap::new();
    for i in items {
        let key = match i.tmdb_id {
            Some(t) => format!("m{t}"),
            None => format!("u{}|{}", i.title.to_lowercase(), i.year.unwrap_or(0)),
        };
        groups.entry(key).or_default().push(i);
    }
    let mut titles: Vec<Title> = groups
        .into_iter()
        .map(|(key, mut items)| {
            items.sort_by_key(|i| std::cmp::Reverse((i.height.unwrap_or(0), i.size_bytes)));
            let first = &items[0];
            let id = if key.starts_with('m') {
                key
            } else {
                format!("i{}", items.iter().map(|i| i.id).min().unwrap_or(0))
            };
            Title {
                id,
                kind: "movie",
                library_id: first.library_id,
                title: first.meta_title.clone().unwrap_or_else(|| first.title.clone()),
                year: first.year,
                overview: first.overview.clone(),
                genres: first.genres.clone(),
                rating: first.rating,
                poster: first.poster.clone(),
                backdrop: first.backdrop.clone(),
                duration_secs: first.duration_secs,
                added_at: items.iter().map(|i| i.added_at.clone()).max().unwrap_or_default(),
                versions: items
                    .iter()
                    .map(|i| Version {
                        item_id: i.id,
                        label: version_label(i),
                        width: i.width,
                        height: i.height,
                        dynamic_range: i.dynamic_range.clone(),
                        video_codec: i.video_codec.clone(),
                        size_bytes: i.size_bytes,
                    })
                    .collect(),
                progress: None,
            }
        })
        .collect();
    // Each title lowercased once, not on every comparison.
    titles.sort_by_cached_key(|t| t.title.to_lowercase());
    titles
}

/// All movie titles the user can see, optionally in one library.
/// A cached title as one profile sees it: only versions in libraries it can see (`None` if
/// none), with its progress.
fn for_profile(
    c: &crate::catalog::CatalogTitle,
    visible: &impl Fn(i64) -> bool,
    states: &HashMap<String, panda_db::WatchState>,
) -> Option<Title> {
    let keep: Vec<usize> = (0..c.title.versions.len()).filter(|&n| visible(c.libraries[n])).collect();
    let first = *keep.first()?;
    let mut t = c.title.clone();
    if keep.len() < t.versions.len() {
        t.versions = keep.iter().map(|&n| c.title.versions[n].clone()).collect();
        t.library_id = c.libraries[first];
    }
    // Matched movies share one key; unmatched versions are keyed per file.
    t.progress = keep
        .iter()
        .filter_map(|&n| states.get(&c.keys[n]))
        .max_by_key(|s| s.last_played_at)
        .map(super::watch::Progress::from);
    Some(t)
}

pub(crate) async fn movie_titles(
    state: &AppState,
    user_id: i64,
    library_id: Option<i64>,
) -> ApiResult<Vec<Title>> {
    // Built once for everyone (crate::catalog); here only this profile's access and progress.
    let catalog = crate::catalog::get(state).await?;
    let allowed = allowed_libraries(state, user_id).await?;
    let states = super::watch::states_by_key(state, user_id).await?;
    let visible =
        |lib: i64| library_id.is_none_or(|l| l == lib) && allowed.as_ref().is_none_or(|a| a.contains(&lib));
    Ok(catalog.movies.iter().filter_map(|c| for_profile(c, &visible, &states)).collect())
}

#[derive(Deserialize)]
struct TitlesQuery {
    library_id: Option<i64>,
    /// `title` (default) or `added` (newest first).
    sort: Option<String>,
    limit: Option<usize>,
}

async fn list_titles(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Query(q): Query<TitlesQuery>,
) -> ApiResult<Json<Vec<Title>>> {
    let mut titles = movie_titles(&state, me.user.id, q.library_id).await?;
    if q.sort.as_deref() == Some("added") {
        titles.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    }
    titles.truncate(q.limit.unwrap_or(usize::MAX));
    Ok(Json(titles))
}

/// One title as this profile sees it (404 if it can't see any version of it).
pub(crate) async fn find_title(state: &AppState, user_id: i64, id: &str) -> ApiResult<Title> {
    let catalog = crate::catalog::get(state).await?;
    let c = catalog.movies.iter().find(|c| c.title.id == id).ok_or(ApiError::NotFound)?;
    let allowed = allowed_libraries(state, user_id).await?;
    let states = super::watch::states_by_key(state, user_id).await?;
    let visible = |lib: i64| allowed.as_ref().is_none_or(|a| a.contains(&lib));
    for_profile(c, &visible, &states).ok_or(ApiError::NotFound)
}

pub(crate) const RELATED_LIMIT: usize = 20;

fn genre_set(genres: Option<&str>) -> Vec<String> {
    genres.unwrap_or_default().split(',').map(|g| g.trim().to_lowercase()).filter(|g| !g.is_empty()).collect()
}

/// Something "More like this" can rank: movies and shows.
pub(crate) trait Rankable {
    fn genres(&self) -> Option<&str>;
    fn rating(&self) -> Option<f64>;
    /// Already watched: listed last.
    fn finished(&self) -> bool;
}

impl Rankable for Title {
    fn genres(&self) -> Option<&str> {
        self.genres.as_deref()
    }
    fn rating(&self) -> Option<f64> {
        self.rating
    }
    fn finished(&self) -> bool {
        self.progress.as_ref().is_some_and(|p| p.finished)
    }
}

/// "More like this" from what's in the library (so everything is playable): entries sharing
/// the most genres with `target_genres`, then the better rated, with finished ones last.
/// `candidates` must already exclude the target itself.
pub(crate) fn rank_related<T: Rankable>(
    target_genres: Option<&str>,
    candidates: Vec<T>,
    limit: usize,
) -> Vec<T> {
    let want = genre_set(target_genres);
    if want.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, T)> = candidates
        .into_iter()
        .filter_map(|t| {
            let shared = genre_set(t.genres()).iter().filter(|g| want.contains(g)).count();
            (shared > 0).then_some((shared, t))
        })
        .collect();
    scored.sort_by(|(a_shared, a), (b_shared, b)| {
        a.finished()
            .cmp(&b.finished())
            .then(b_shared.cmp(a_shared))
            .then(b.rating().unwrap_or(0.0).total_cmp(&a.rating().unwrap_or(0.0)))
    });
    scored.into_iter().take(limit).map(|(_, t)| t).collect()
}

pub(crate) fn related(target: &Title, all: Vec<Title>, limit: usize) -> Vec<Title> {
    let genres = target.genres.clone();
    rank_related(genres.as_deref(), all.into_iter().filter(|t| t.id != target.id).collect(), limit)
}

async fn related_titles(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Title>>> {
    let all = movie_titles(&state, me.user.id, None).await?;
    let target = all.iter().find(|t| t.id == id).cloned().ok_or(ApiError::NotFound)?;
    Ok(Json(related(&target, all, RELATED_LIMIT)))
}

async fn get_title(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<Title>> {
    Ok(Json(find_title(&state, me.user.id, &id).await?))
}

/// Play a title: the requested version, or the one this device plays most cheaply.
async fn play_title(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<PlaybackRequest>>,
) -> ApiResult<Json<PlaybackResponse>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let title = find_title(&state, me.user.id, &id).await?;
    let item_id = match req.version {
        Some(v) if title.versions.iter().any(|x| x.item_id == v) => v,
        Some(_) => return Err(ApiError::NotFound),
        None => {
            let profile = req.profile.clone().unwrap_or_default();
            let mut medias: Vec<(i64, MediaInfo)> = Vec::new();
            for v in &title.versions {
                if let Ok((_, m)) = load(&state, v.item_id).await {
                    medias.push((v.item_id, m));
                }
            }
            let refs: Vec<(i64, &MediaInfo)> = medias.iter().map(|(i, m)| (*i, m)).collect();
            playback::choose_version(&refs, &profile).ok_or(ApiError::NotFound)?
        }
    };
    Ok(Json(play(&state, &me, item_id, req).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(id: &str, genres: &str, rating: f64, finished: bool) -> Title {
        let mut t = Title {
            id: id.into(),
            kind: "movie",
            library_id: 1,
            title: id.into(),
            year: None,
            overview: None,
            genres: Some(genres.into()),
            rating: Some(rating),
            poster: None,
            backdrop: None,
            duration_secs: None,
            added_at: String::new(),
            versions: Vec::new(),
            progress: None,
        };
        if finished {
            t.progress = Some(crate::routes::watch::Progress {
                position_secs: 0.0,
                duration_secs: None,
                finished: true,
                fraction: 1.0,
                last_played_at: 0,
            });
        }
        t
    }

    #[test]
    fn related_prefers_shared_genres_then_rating_and_unwatched() {
        let target = title("m1", "Drama, Crime", 8.0, false);
        let all = vec![
            target.clone(),
            title("comedy", "Comedy", 9.0, false),
            title("crime", "Crime", 7.0, false),
            title("both-low", "Crime, Drama", 6.0, false),
            title("both-high", "Drama, Crime, Thriller", 8.5, false),
            title("both-seen", "Drama, Crime", 9.9, true),
        ];
        let ids: Vec<_> = related(&target, all, 10).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["both-high", "both-low", "crime", "both-seen"]);
    }
}

// ---- details page: cast, crew and facts ----

/// How long a fetched details page is kept before asking TMDB again.
const DETAILS_MAX_AGE_SECS: i64 = 30 * 86_400;
/// Cast shown on the details page (top billed).
const CAST_LIMIT: usize = 16;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Person {
    /// TMDB person id (their page).
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    /// Character played, or the job ("Director").
    pub role: Option<String>,
    /// Headshot image key (`/api/images/{key}`).
    pub image: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct TitleDetails {
    pub tagline: Option<String>,
    /// `2024-03-01`.
    pub release_date: Option<String>,
    /// Age rating in the server's region ("PG-13").
    pub certification: Option<String>,
    pub runtime_mins: Option<i64>,
    /// ISO 639-1 ("en").
    pub original_language: Option<String>,
    pub studios: Vec<String>,
    pub directors: Vec<Person>,
    pub writers: Vec<String>,
    pub cast: Vec<Person>,
    /// Shows: how many seasons there are (TMDB), for "Get more seasons".
    #[serde(default)]
    pub seasons: Option<i64>,
    /// Shows: seasons taken from another TMDB show (an anthology's stories, matched by hand),
    /// with that show's name and artwork. Never cached: added per request.
    #[serde(default, skip_deserializing)]
    pub season_art: Vec<SeasonArt>,
    /// TMDB's score for this title (or a season's story), kept with the cached details.
    #[serde(default)]
    pub tmdb_rating: Option<f64>,
    /// Movies: the series of films it's part of (its other films: `/api/titles/{id}/collection`).
    #[serde(default)]
    pub collection: Option<CollectionLink>,
    /// Where it was made ("United States").
    #[serde(default)]
    pub countries: Vec<String>,
    /// Shows: "Returning Series", "Ended", ...
    #[serde(default)]
    pub status: Option<String>,
    /// Shows: the next episode to air, with its date (`2026-12-05`).
    #[serde(default)]
    pub next_episode: Option<UpcomingEpisode>,
    /// Which shape of cached details this is: older ones are fetched again once.
    #[serde(default)]
    pub v: u32,
    /// Its logo (its name as artwork; image key), when it has one. Per request.
    #[serde(default, skip_deserializing)]
    pub logo: Option<String>,
    /// The audio and subtitle languages of your copy (its first version). Per request.
    #[serde(default, skip_deserializing)]
    pub audio: Vec<TrackInfo>,
    #[serde(default, skip_deserializing)]
    pub subtitles: Vec<TrackInfo>,
    /// With several versions whose languages differ: each one's (Play picks the version that
    /// suits the device, so the first version's alone can mislead). Per request.
    #[serde(default, skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub version_languages: Vec<VersionLanguages>,
    /// Every rating to show: TMDB's, then `IMDb`, Rotten Tomatoes and Metacritic when OMDb is set
    /// up. Never cached: added per request (they're refreshed monthly on their own).
    #[serde(default, skip_deserializing)]
    pub ratings: Vec<crate::services::providers::Rating>,
}

/// The shape of cached details now (see `TitleDetails::v`).
const DETAILS_VERSION: u32 = 2;
/// A running show's details are fetched again after this long (new episodes get dates), and
/// as soon as the episode they called "next" has aired.
const RUNNING_SHOW_MAX_AGE_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UpcomingEpisode {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
}

/// Whether cached show details are still good: the current shape, and for a show still
/// running, not past a day old or past the air date of the episode they called next.
fn show_details_fresh(d: &TitleDetails, age_secs: i64) -> bool {
    if d.v < DETAILS_VERSION || d.seasons.is_none() {
        return false;
    }
    let running = !matches!(d.status.as_deref(), Some("Ended" | "Canceled"));
    if !running {
        return true;
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let next_aired =
        d.next_episode.as_ref().and_then(|e| e.air_date.as_deref()).is_some_and(|a| a < today.as_str());
    age_secs < RUNNING_SHOW_MAX_AGE_SECS && !next_aired
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CollectionLink {
    pub id: i64,
    pub name: String,
}

/// One audio or subtitle language of a file: ISO 639 code (`eng`) and what kind it is
/// ("5.1", "Forced"). The app names the language.
/// One version's languages ("4K Dolby Vision": its audio and subtitles).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct VersionLanguages {
    pub label: String,
    pub audio: Vec<TrackInfo>,
    pub subtitles: Vec<TrackInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TrackInfo {
    pub language: Option<String>,
    pub detail: Option<String>,
}

/// A file's languages, each once: audio with its channel layout, subtitles marked forced.
fn languages(media: &MediaInfo) -> (Vec<TrackInfo>, Vec<TrackInfo>) {
    let layout = |channels: u32| match channels {
        0 => None,
        1 => Some("Mono".to_string()),
        2 => Some("Stereo".to_string()),
        6 => Some("5.1".to_string()),
        8 => Some("7.1".to_string()),
        n => Some(format!("{n} ch")),
    };
    let mut audio: Vec<TrackInfo> = Vec::new();
    for a in &media.audio {
        let t = TrackInfo { language: a.language.clone(), detail: layout(a.channels) };
        if !audio.contains(&t) {
            audio.push(t);
        }
    }
    let mut subtitles: Vec<TrackInfo> = Vec::new();
    for s in &media.subtitles {
        let t = TrackInfo { language: s.language.clone(), detail: s.forced.then(|| "Forced".to_string()) };
        if !subtitles.contains(&t) {
            subtitles.push(t);
        }
    }
    (audio, subtitles)
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SeasonArt {
    pub season: i64,
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub overview: Option<String>,
    pub year: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SeasonQuery {
    season: Option<i64>,
}

/// Cast, crew and facts for a title's details page. Fetched from TMDB the first time anyone
/// opens it (headshots cached like posters), then served from the database. Without TMDB, or
/// for an unmatched file, the page simply has no details (never an error).
async fn title_details(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<TitleDetails>> {
    // The same access check as the title itself, before anything else.
    let title = find_title(&state, me.user.id, &id).await?;
    let Some(tmdb_id) = id.strip_prefix('m').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(Json(TitleDetails::default()));
    };
    // The logo is looked up while TMDB answers (a first view waits on both).
    let ids = [tmdb_id];
    let (details, logos) = tokio::join!(
        movie_details(&state, tmdb_id),
        super::home_more::logos_for(&state, "movie", panda_db::MetadataKind::Movie, &ids),
    );
    let mut details = details?;
    details.logo = logos.get(&tmdb_id).cloned().flatten();
    let mut per_version = Vec::new();
    for v in &title.versions {
        if let Ok((_, media)) = load(&state, v.item_id).await {
            let (audio, subtitles) = languages(&media);
            per_version.push(VersionLanguages { label: v.label.clone(), audio, subtitles });
        }
    }
    if let Some(first) = per_version.first() {
        (details.audio, details.subtitles) = (first.audio.clone(), first.subtitles.clone());
    }
    let differ = per_version.windows(2).any(|w| w[0].audio != w[1].audio || w[0].subtitles != w[1].subtitles);
    if differ {
        details.version_languages = per_version;
    }
    details.ratings = crate::services::providers::ratings(
        &state,
        panda_db::MetadataKind::Movie,
        tmdb_id,
        details.tmdb_rating,
    )
    .await;
    Ok(Json(details))
}

pub(crate) async fn movie_details(state: &AppState, tmdb_id: i64) -> ApiResult<TitleDetails> {
    let now = crate::services::settings::now();
    let cached = state.db.title_details("movie", tmdb_id).await?;
    if let Some((json, at)) = &cached
        && now - at < DETAILS_MAX_AGE_SECS
        && let Ok(d) = serde_json::from_str::<TitleDetails>(json)
        // Saved before people had ids, or the collection and countries: fetch again once.
        && d.v >= DETAILS_VERSION
    {
        return Ok(d);
    }
    let Some(tmdb) = state.integrations().tmdb.clone() else {
        return Ok(TitleDetails::default());
    };
    let region = state.config.tmdb.region.clone().unwrap_or_else(|| "US".into());
    match tmdb.movie_full(tmdb_id).await {
        Ok(full) => {
            let details = build_details(state, &full, &region);
            if let Ok(json) = serde_json::to_string(&details) {
                state.db.save_title_details("movie", tmdb_id, &json, now).await?;
            }
            Ok(details)
        }
        Err(e) => {
            tracing::warn!(tmdb_id, error = %e, "could not fetch title details");
            // A stale copy beats nothing.
            Ok(cached.and_then(|(json, _)| serde_json::from_str(&json).ok()).unwrap_or_default())
        }
    }
}

/// The same for a show (`/api/series/{name}/details`): creators, cast, network, age rating, and
/// the artwork of seasons matched to other shows.
pub(crate) async fn series_details(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
    Query(q): Query<SeasonQuery>,
) -> ApiResult<Json<TitleDetails>> {
    let show = visible_series(&state, me.user.id, &name).await?;
    let mut matches = state.db.season_matches(&panda_metadata::matching::normalize(&show.series)).await?;
    fill_season_stories(&state, &mut matches).await;
    // `?season=N` of a season taken from another show (an anthology's story): that show's cast,
    // creators and facts. Any other season: the show's own.
    let from = q.season.and_then(|n| matches.iter().find(|m| m.season == n)).map(|m| m.tmdb_id);
    // The logo is looked up while TMDB answers (a first view waits on both).
    let tmdb_id = from.or(show.tmdb_id);
    let logo = async {
        let id = tmdb_id?;
        super::home_more::logos_for(&state, "series", panda_db::MetadataKind::Series, &[id])
            .await
            .remove(&id)
            .flatten()
    };
    let (details, logo) = tokio::join!(show_details(&state, tmdb_id), logo);
    let Json(mut details) = details?;
    details.logo = logo;
    // The languages of its first episode (a show's are usually the same throughout).
    let first = panda_db::ItemFilter {
        kind: Some(panda_db::ItemKind::Episode),
        folder: Some(show.series.clone()),
        limit: Some(1),
        ..Default::default()
    };
    if let Some(item) = state.db.items(&first).await?.first()
        && let Ok((_, media)) = load(&state, item.id).await
    {
        (details.audio, details.subtitles) = languages(&media);
    }
    details.season_art = matches
        .into_iter()
        .map(|m| SeasonArt {
            season: m.season,
            title: m.title,
            poster: m.poster,
            backdrop: m.backdrop,
            overview: m.overview,
            year: m.year,
        })
        .collect();
    Ok(Json(details))
}

/// Season matches saved before they kept their story's description and year get them now
/// (once: they're saved).
async fn fill_season_stories(state: &AppState, matches: &mut [panda_db::SeasonMatch]) {
    let Some(tmdb) = state.integrations().tmdb.clone() else { return };
    for m in matches.iter_mut().filter(|m| m.overview.is_none() && m.year.is_none()) {
        let Ok(d) = tmdb.tv(m.tmdb_id).await else { continue };
        m.overview = d.overview.filter(|o| !o.is_empty());
        m.year = d.first_air_date.as_deref().and_then(|y| y.get(..4)).and_then(|y| y.parse().ok());
        if let Err(e) = state.db.set_season_match(m, crate::services::settings::now()).await {
            tracing::warn!(error = %e, "saving a season's story failed");
        }
    }
}

async fn show_details(state: &AppState, tmdb_id: Option<i64>) -> ApiResult<Json<TitleDetails>> {
    let Some(tmdb_id) = tmdb_id else { return Ok(Json(TitleDetails::default())) };
    let Json(mut details) = tv_details(state, tmdb_id).await?;
    details.ratings = crate::services::providers::ratings(
        state,
        panda_db::MetadataKind::Series,
        tmdb_id,
        details.tmdb_rating,
    )
    .await;
    Ok(Json(details))
}

async fn tv_details(state: &AppState, tmdb_id: i64) -> ApiResult<Json<TitleDetails>> {
    let state = state.clone();
    let now = crate::services::settings::now();
    let cached = state.db.title_details("series", tmdb_id).await?;
    if let Some((json, at)) = &cached
        && now - at < DETAILS_MAX_AGE_SECS
        && let Ok(d) = serde_json::from_str::<TitleDetails>(json)
        && show_details_fresh(&d, now - at)
    {
        return Ok(Json(d));
    }
    let Some(tmdb) = state.integrations().tmdb.clone() else {
        return Ok(Json(TitleDetails::default()));
    };
    let region = state.config.tmdb.region.clone().unwrap_or_else(|| "US".into());
    match tmdb.tv_full(tmdb_id).await {
        Ok(full) => {
            let details = build_tv_details(&state, &full, &region);
            if let Ok(json) = serde_json::to_string(&details) {
                state.db.save_title_details("series", tmdb_id, &json, now).await?;
            }
            Ok(Json(details))
        }
        Err(e) => {
            tracing::warn!(tmdb_id, error = %e, "could not fetch show details");
            Ok(Json(cached.and_then(|(json, _)| serde_json::from_str(&json).ok()).unwrap_or_default()))
        }
    }
}

/// A show this profile may see, by name (else not found).
pub(crate) async fn visible_series(
    state: &AppState,
    user_id: i64,
    name: &str,
) -> ApiResult<panda_db::SeriesSummary> {
    let allowed = allowed_libraries(state, user_id).await?;
    crate::catalog::find_series(state, allowed.as_deref(), name).await?.ok_or(ApiError::NotFound)
}

pub(crate) fn build_details(
    state: &AppState,
    full: &panda_metadata::tmdb::MovieFull,
    region: &str,
) -> TitleDetails {
    let mut cast: Vec<_> = full.credits.cast.iter().collect();
    cast.sort_by_key(|c| c.order.unwrap_or(i64::MAX));
    cast.truncate(CAST_LIMIT);
    let directors: Vec<_> =
        full.credits.crew.iter().filter(|c| c.job.as_deref() == Some("Director")).take(2).collect();
    let mut writers: Vec<String> = Vec::new();
    for c in full.credits.crew.iter().filter(|c| c.department.as_deref() == Some("Writing")) {
        if !writers.contains(&c.name) && writers.len() < 4 {
            writers.push(c.name.clone());
        }
    }
    // Headshots download in the background (the details don't wait on them).
    let headshot = |path: &Option<String>| {
        path.as_deref().and_then(|p| super::images::promise(state, panda_metadata::ImageSize::Profile, p))
    };
    let director_images: Vec<_> = directors.iter().map(|d| headshot(&d.profile_path)).collect();
    let cast_images: Vec<_> = cast.iter().map(|c| headshot(&c.profile_path)).collect();
    TitleDetails {
        seasons: None,
        season_art: Vec::new(),
        ratings: Vec::new(),
        tmdb_rating: full.vote_average,
        collection: full
            .belongs_to_collection
            .as_ref()
            .map(|c| CollectionLink { id: c.id, name: c.name.clone() }),
        countries: full.production_countries.iter().map(|c| c.name.clone()).collect(),
        status: None,
        next_episode: None,
        v: DETAILS_VERSION,
        logo: None,
        audio: Vec::new(),
        subtitles: Vec::new(),
        version_languages: Vec::new(),
        tagline: full.tagline.clone().filter(|t| !t.trim().is_empty()),
        release_date: full.release_date.clone().filter(|d| !d.is_empty()),
        certification: full.certification(region),
        runtime_mins: full.runtime.filter(|r| *r > 0),
        original_language: full.original_language.clone(),
        studios: full.production_companies.iter().take(3).map(|c| c.name.clone()).collect(),
        directors: directors
            .iter()
            .zip(director_images)
            .map(|(d, image)| Person {
                id: Some(d.id),
                name: d.name.clone(),
                role: Some("Director".into()),
                image,
            })
            .collect(),
        writers,
        cast: cast
            .iter()
            .zip(cast_images)
            .map(|(c, image)| Person {
                id: Some(c.id),
                name: c.name.clone(),
                role: c.character.clone().filter(|r| !r.trim().is_empty()),
                image,
            })
            .collect(),
    }
}

/// The same facts for a show: creators in the directors' place, networks as studios.
pub(crate) fn build_tv_details(
    state: &AppState,
    full: &panda_metadata::tmdb::TvFull,
    region: &str,
) -> TitleDetails {
    let mut cast: Vec<_> = full.credits.cast.iter().collect();
    cast.sort_by_key(|c| c.order.unwrap_or(i64::MAX));
    cast.truncate(CAST_LIMIT);
    let creators: Vec<_> = full.created_by.iter().take(2).collect();
    // Headshots download in the background (the details don't wait on them).
    let headshot = |path: &Option<String>| {
        path.as_deref().and_then(|p| super::images::promise(state, panda_metadata::ImageSize::Profile, p))
    };
    let creator_images: Vec<_> = creators.iter().map(|c| headshot(&c.profile_path)).collect();
    let cast_images: Vec<_> = cast.iter().map(|c| headshot(&c.profile_path)).collect();
    TitleDetails {
        seasons: full.number_of_seasons,
        season_art: Vec::new(),
        ratings: Vec::new(),
        tmdb_rating: full.vote_average,
        collection: None,
        countries: full.production_countries.iter().map(|c| c.name.clone()).collect(),
        status: full.status.clone(),
        next_episode: full.next_episode_to_air.as_ref().map(|e| UpcomingEpisode {
            season: e.season_number,
            episode: e.episode_number,
            name: e.name.clone().filter(|n| !n.trim().is_empty()),
            overview: e.overview.clone().filter(|o| !o.trim().is_empty()),
            air_date: e.air_date.clone(),
        }),
        v: DETAILS_VERSION,
        logo: None,
        audio: Vec::new(),
        subtitles: Vec::new(),
        version_languages: Vec::new(),
        tagline: full.tagline.clone().filter(|t| !t.trim().is_empty()),
        release_date: full.first_air_date.clone().filter(|d| !d.is_empty()),
        certification: full.certification(region),
        runtime_mins: None,
        original_language: full.original_language.clone(),
        studios: full.networks.iter().take(3).map(|c| c.name.clone()).collect(),
        directors: creators
            .iter()
            .zip(creator_images)
            .map(|(c, image)| Person {
                id: Some(c.id),
                name: c.name.clone(),
                role: Some("Creator".into()),
                image,
            })
            .collect(),
        writers: Vec::new(),
        cast: cast
            .iter()
            .zip(cast_images)
            .map(|(c, image)| Person {
                id: Some(c.id),
                name: c.name.clone(),
                role: c.character.clone().filter(|r| !r.trim().is_empty()),
                image,
            })
            .collect(),
    }
}
