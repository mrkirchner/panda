//! Search Sonarr/Radarr and request media (Overseerr-style).

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use futures_util::future::join_all;
use panda_arr::progress::{self, Progress};
use panda_arr::{Image, Radarr, Sonarr};
use panda_db::{MediaRequest, NewRequest, RequestKind, RequestStatus, Role};
use serde::{Deserialize, Serialize};

use tokio::time::timeout;

use super::titles::movie_titles;
use crate::auth::{CurrentUser, allowed_libraries};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, Tier};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/search", get(search))
        .route("/requests", get(list).post(create))
        .route("/requests/mine", get(mine))
        .route("/requests/{id}", axum::routing::delete(cancel))
        .route("/series/{name}/seasons", axum::routing::post(more_seasons))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    kind: RequestKind,
}

#[derive(Serialize)]
struct SearchResult {
    kind: RequestKind,
    title: String,
    year: Option<i32>,
    overview: Option<String>,
    poster: Option<String>,
    tmdb_id: Option<i64>,
    tvdb_id: Option<i64>,
    /// Already added to Sonarr/Radarr.
    added: bool,
}

fn poster(images: &[Image]) -> Option<String> {
    images.iter().find(|i| i.cover_type == "poster").and_then(|i| i.remote_url.clone())
}

async fn search(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<SearchResult>>> {
    let results = match q.kind {
        RequestKind::Movie => {
            let integrations = state.integrations();
            let radarr =
                integrations.radarrs().into_iter().next().ok_or(ApiError::NotConfigured("radarr"))?.1;
            radarr
                .client
                .lookup(&q.q)
                .await?
                .into_iter()
                .map(|m| SearchResult {
                    kind: RequestKind::Movie,
                    poster: poster(&m.images),
                    title: m.title,
                    year: m.year,
                    overview: m.overview,
                    tmdb_id: Some(m.tmdb_id),
                    tvdb_id: None,
                    added: m.id.is_some(),
                })
                .collect()
        }
        RequestKind::Series => {
            let integrations = state.integrations();
            let sonarr =
                integrations.sonarrs().into_iter().next().ok_or(ApiError::NotConfigured("sonarr"))?.1;
            sonarr
                .client
                .lookup(&q.q)
                .await?
                .into_iter()
                .map(|s| SearchResult {
                    kind: RequestKind::Series,
                    poster: poster(&s.images),
                    title: s.title,
                    year: s.year,
                    overview: s.overview,
                    tmdb_id: s.tmdb_id,
                    tvdb_id: Some(s.tvdb_id),
                    added: s.id.is_some(),
                })
                .collect()
        }
    };
    Ok(Json(results))
}

/// Every account's requests (with Radarr/Sonarr errors): admins only. Profiles see their own
/// through `/requests/mine`.
async fn list(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<MediaRequest>>> {
    if me.user.role != Role::Admin {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(state.db.requests().await?))
}

/// Record the request, then send it to Sonarr/Radarr.
/// Every request is auto-approved: it goes straight to every Radarr (movies) or Sonarr (shows)
/// that's set up (HD and 4K), which add it monitored and start searching.
async fn create(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(mut new): Json<NewRequest>,
) -> ApiResult<(StatusCode, Json<MediaRequest>)> {
    new.user_id = Some(me.user.id);
    // Nothing to send it to: refuse before anything is saved (no stray failed request).
    let integrations = state.integrations();
    match new.kind {
        RequestKind::Movie if integrations.radarrs().is_empty() => {
            return Err(ApiError::NotConfigured("radarr"));
        }
        RequestKind::Series if integrations.sonarrs().is_empty() => {
            return Err(ApiError::NotConfigured("sonarr"));
        }
        _ => {}
    }
    // Only artwork keys this server issued (search results carry them), never arbitrary paths.
    new.poster = new.poster.filter(|k| state.images.path_for_key(k).is_some());
    // Shows found through TMDB (TV search) only have a TMDB id; Sonarr adds by TVDB id.
    if new.kind == RequestKind::Series
        && new.tvdb_id.is_none()
        && let Some(tmdb_id) = new.tmdb_id
    {
        let tmdb = state.integrations().tmdb.clone().ok_or(ApiError::NotConfigured("tmdb"))?;
        new.tvdb_id = tmdb.external_ids(true, tmdb_id).await?.tvdb_id;
    }
    let lookup_term = match (new.kind, new.tmdb_id, new.tvdb_id) {
        (RequestKind::Movie, Some(id), _) => format!("tmdb:{id}"),
        (RequestKind::Series, _, Some(id)) => format!("tvdb:{id}"),
        (RequestKind::Movie, None, _) => {
            return Err(ApiError::BadRequest("movie requests need tmdb_id".into()));
        }
        (RequestKind::Series, _, None) => {
            return Err(ApiError::BadRequest("series requests need tvdb_id".into()));
        }
    };

    let request = state.db.create_request(&new).await.map_err(|e| {
        if e.is_unique_violation() { ApiError::BadRequest("already requested".into()) } else { e.into() }
    })?;

    // Choosing seasons: just those (a sorted, distinct list); none or empty means all.
    let seasons = new.seasons.clone().filter(|s| !s.is_empty()).map(|mut s| {
        s.sort_unstable();
        s.dedup();
        s
    });
    let failures = send_to_arr(&state, new.kind, &lookup_term, seasons.as_deref()).await;
    let (status, error) = match failures {
        Ok(f) if f.is_empty() => (RequestStatus::Approved, None),
        // Some servers took it: it's on its way, but say which one didn't.
        Ok(f) => (RequestStatus::Approved, Some(f.join("; "))),
        Err(e) => (RequestStatus::Failed, Some(e.to_string())),
    };
    state.db.set_request_status(request.id, status, error.as_deref()).await?;
    if status == RequestStatus::Failed {
        return Err(ApiError::BadRequest(error.unwrap_or_default()));
    }

    let saved =
        state.db.requests().await?.into_iter().find(|r| r.id == request.id).ok_or(ApiError::NotFound)?;
    // Search's remembered lookups predate this request (it's now on a server).
    super::search::forget_lookups();
    Ok((StatusCode::CREATED, Json(saved)))
}

/// Cancel your own request while nothing has come of it (the servers are still searching or
/// waiting: a title they can't find). Each server's entry is taken off its list (files kept)
/// when this request put it there, nothing of it is downloaded or downloading, and no one else
/// asked for it too. Refused once something is on its way or it's in the library.
async fn cancel(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    // Only your own (another profile's request is "not found", like any id you can't see).
    let request = state
        .db
        .requests_for_user(me.user.id)
        .await?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or(ApiError::NotFound)?;
    let since = chrono::DateTime::parse_from_rfc3339(&request.created_at)
        .map(|t| t.with_timezone(&chrono::Utc) - chrono::Duration::minutes(1))
        .ok();
    // Put there by this request (added after it was made), not by an admin earlier.
    let ours =
        |added: Option<chrono::DateTime<chrono::Utc>>| matches!((added, since), (Some(a), Some(s)) if a >= s);
    // Anyone else asking for it keeps it on the servers.
    let shared = state.db.requests().await?.iter().any(|r| {
        r.id != request.id
            && r.kind == request.kind
            && match request.kind {
                RequestKind::Movie => r.tmdb_id.is_some() && r.tmdb_id == request.tmdb_id,
                RequestKind::Series => r.tvdb_id.is_some() && r.tvdb_id == request.tvdb_id,
            }
    });
    let integrations = state.integrations();
    // First look, then act: nothing is removed if any server has it coming.
    let (mut movies, mut shows) = (Vec::new(), Vec::new());
    match (request.kind, request.tmdb_id, request.tvdb_id) {
        (RequestKind::Movie, Some(tmdb_id), _) => {
            for (_, radarr) in integrations.radarrs() {
                let Some(m) = radarr.client.movie_by_tmdb(tmdb_id).await? else { continue };
                let Some(mid) = m.id else { continue };
                if m.has_file || !radarr.client.queue_for_movie(mid).await?.is_empty() {
                    return Err(ApiError::BadRequest("it's already downloading".into()));
                }
                if ours(m.added) && !shared {
                    movies.push((radarr, mid));
                }
            }
        }
        (RequestKind::Series, _, Some(tvdb_id)) => {
            for (_, sonarr) in integrations.sonarrs() {
                let Some(series) = sonarr.client.series_by_tvdb(tvdb_id).await? else { continue };
                let Some(sid) = series.id else { continue };
                let files = series.statistics.as_ref().map_or(0, |st| st.episode_file_count);
                if files > 0 || !sonarr.client.queue_for_series(sid).await?.is_empty() {
                    return Err(ApiError::BadRequest("it's already downloading".into()));
                }
                if ours(series.added) && !shared {
                    shows.push((sonarr, sid));
                }
            }
        }
        _ => {}
    }
    for (radarr, mid) in movies {
        radarr.client.remove_movie(mid).await?;
    }
    for (sonarr, sid) in shows {
        sonarr.client.remove_series(sid).await?;
    }
    state.db.delete_request(request.id).await?;
    super::search::forget_lookups();
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MoreSeasons {
    seasons: Vec<i64>,
}

/// Get more seasons of a show you have: Sonarr monitors and searches them (adding the show if
/// it isn't there, e.g. after a cleanup). Recorded as your request when you hadn't made one, so
/// its progress shows in My List.
async fn more_seasons(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
    Json(body): Json<MoreSeasons>,
) -> ApiResult<StatusCode> {
    let show = super::titles::visible_series(&state, me.user.id, &name).await?;
    if state.integrations().sonarrs().is_empty() {
        return Err(ApiError::NotConfigured("sonarr"));
    }
    let mut seasons: Vec<i64> = body.seasons.into_iter().filter(|s| *s > 0).collect();
    seasons.sort_unstable();
    seasons.dedup();
    if seasons.is_empty() {
        return Err(ApiError::Validation("choose at least one season".into()));
    }
    let tmdb_show =
        show.tmdb_id.ok_or_else(|| ApiError::Validation("this show isn't matched to TMDB".into()))?;
    let tmdb = state.integrations().tmdb.clone().ok_or(ApiError::NotConfigured("tmdb"))?;
    let sonarr_key = tmdb.external_ids(true, tmdb_show).await?.tvdb_id.ok_or(ApiError::NotFound)?;
    let new = NewRequest {
        kind: RequestKind::Series,
        title: show.meta_title.clone().unwrap_or_else(|| show.series.clone()),
        year: show.year,
        tmdb_id: Some(tmdb_show),
        tvdb_id: Some(sonarr_key),
        user_id: Some(me.user.id),
        poster: show.poster.clone(),
        seasons: None,
    };
    match state.db.create_request(&new).await {
        Ok(_) => {}
        Err(e) if e.is_unique_violation() => {} // asked for before: same request, more seasons
        Err(e) => return Err(e.into()),
    }
    send_to_arr(&state, RequestKind::Series, &format!("tvdb:{sonarr_key}"), Some(&seasons)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Add the title to every server of its kind. `Ok` lists the servers that failed (empty: all
/// took it); `Err` when none is set up or none took it.
async fn send_to_arr(
    state: &AppState,
    kind: RequestKind,
    term: &str,
    seasons: Option<&[i64]>,
) -> ApiResult<Vec<String>> {
    let integrations = state.integrations();
    let mut failures = Vec::new();
    let mut sent = 0;
    match kind {
        RequestKind::Movie => {
            let servers = integrations.radarrs();
            if servers.is_empty() {
                return Err(ApiError::NotConfigured("radarr"));
            }
            for (tier, radarr) in servers {
                let result = async {
                    let movie =
                        radarr.client.lookup(term).await?.into_iter().next().ok_or(ApiError::NotFound)?;
                    if movie.id.is_none() {
                        radarr.client.add(&movie, &radarr.defaults).await?;
                    }
                    Ok::<_, ApiError>(())
                }
                .await;
                match result {
                    Ok(()) => sent += 1,
                    Err(e) => failures.push(format!("Radarr {}: {e}", tier.label())),
                }
            }
        }
        RequestKind::Series => {
            let servers = integrations.sonarrs();
            if servers.is_empty() {
                return Err(ApiError::NotConfigured("sonarr"));
            }
            for (tier, sonarr) in servers {
                let result = async {
                    let series =
                        sonarr.client.lookup(term).await?.into_iter().next().ok_or(ApiError::NotFound)?;
                    match seasons {
                        Some(wanted) => sonarr.client.add_seasons(&series, &sonarr.defaults, wanted).await?,
                        None if series.id.is_none() => {
                            sonarr.client.add(&series, &sonarr.defaults).await?;
                        }
                        None => {}
                    }
                    Ok::<_, ApiError>(())
                }
                .await;
                match result {
                    Ok(()) => sent += 1,
                    Err(e) => failures.push(format!("Sonarr {}: {e}", tier.label())),
                }
            }
        }
    }
    if sent == 0 {
        return Err(ApiError::BadRequest(failures.join("; ")));
    }
    Ok(failures)
}

/// How long one Radarr/Sonarr status call may take before the TV gets "unknown" for it.
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);

/// One server's view of a requested title.
#[derive(Debug, Serialize)]
struct TierProgress {
    tier: Tier,
    /// `None`: that server didn't answer (or doesn't have the title).
    progress: Option<Progress>,
}

/// A profile's request with live progress, for the TV's My List.
#[derive(Debug, Serialize)]
struct MyRequest {
    #[serde(flatten)]
    request: MediaRequest,
    tiers: Vec<TierProgress>,
    /// Once it's in the library: what to open (`/title/<id>` or `/series/<name>`).
    title_id: Option<String>,
    series: Option<String>,
}

/// The signed-in profile's requests with each server's progress (searching, downloading x%,
/// importing, available). Servers are asked in parallel and each gets a few seconds.
async fn mine(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<MyRequest>>> {
    let requests = state.db.requests_for_user(me.user.id).await?;
    if requests.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let titles = movie_titles(&state, me.user.id, None).await?;
    let allowed = allowed_libraries(&state, me.user.id).await?;
    let series = crate::catalog::series(&state, None).await?;
    let integrations = state.integrations();

    let out = join_all(requests.into_iter().map(|r| {
        let (integrations, titles, series, allowed) = (&integrations, &titles, &series, &allowed);
        async move {
            let tiers = match r.kind {
                RequestKind::Movie => {
                    join_all(integrations.radarrs().into_iter().map(|(tier, radarr)| async move {
                        let progress = match r.tmdb_id {
                            Some(id) => timeout(STATUS_TIMEOUT, movie_progress(&radarr.client, id))
                                .await
                                .ok()
                                .and_then(Result::ok)
                                .flatten(),
                            None => None,
                        };
                        TierProgress { tier, progress }
                    }))
                    .await
                }
                RequestKind::Series => {
                    join_all(integrations.sonarrs().into_iter().map(|(tier, sonarr)| async move {
                        let progress = match r.tvdb_id {
                            Some(id) => timeout(STATUS_TIMEOUT, series_progress(&sonarr.client, id))
                                .await
                                .ok()
                                .and_then(Result::ok)
                                .flatten(),
                            None => None,
                        };
                        TierProgress { tier, progress }
                    }))
                    .await
                }
            };
            let title_id = (r.kind == RequestKind::Movie)
                .then(|| r.tmdb_id.map(|id| format!("m{id}")))
                .flatten()
                .filter(|id| titles.iter().any(|t| &t.id == id));
            let series_name = (r.kind == RequestKind::Series)
                .then(|| {
                    series
                        .iter()
                        .filter(|s| allowed.as_ref().is_none_or(|a| a.contains(&s.library_id)))
                        .find(|s| s.tmdb_id.is_some() && s.tmdb_id == r.tmdb_id)
                        .map(|s| s.series.clone())
                })
                .flatten();
            MyRequest { request: r, tiers, title_id, series: series_name }
        }
    }))
    .await;
    // Arrived in the library: it joins My List, once (removing it later sticks). The flag in
    // this response is still the old one, so the TV shows it as a request this time and as a
    // saved title from the next load (when its home data already has it).
    let now = crate::services::settings::now();
    for m in out.iter().filter(|m| !m.request.listed) {
        let found = match (&m.title_id, &m.series) {
            (Some(id), _) => Some(("title", id)),
            (None, Some(name)) => Some(("series", name)),
            _ => None,
        };
        if let Some((kind, reference)) = found {
            state.db.add_favorite(me.user.id, kind, reference, now).await?;
            state.db.mark_request_listed(m.request.id).await?;
        }
    }
    Ok(Json(out))
}

async fn movie_progress(radarr: &Radarr, tmdb_id: i64) -> panda_arr::Result<Option<Progress>> {
    let Some(movie) = radarr.movie_by_tmdb(tmdb_id).await? else { return Ok(None) };
    let Some(id) = movie.id else { return Ok(None) };
    let queue = radarr.queue_for_movie(id).await?;
    Ok(Some(progress::summarize(if movie.has_file { 1.0 } else { 0.0 }, &queue)))
}

async fn series_progress(sonarr: &Sonarr, tvdb_id: i64) -> panda_arr::Result<Option<Progress>> {
    let Some(series) = sonarr.series_by_tvdb(tvdb_id).await? else { return Ok(None) };
    let Some(id) = series.id else { return Ok(None) };
    let queue = sonarr.queue_for_series(id).await?;
    Ok(Some(progress::summarize(series.statistics.unwrap_or_default().on_disk(), &queue)))
}
