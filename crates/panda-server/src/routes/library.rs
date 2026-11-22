use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use panda_db::{Item, ItemFilter, Library, SeriesSummary};
use panda_media::probe::MediaInfo;
use serde::Serialize;

use crate::auth::{CurrentUser, allowed_libraries, ensure_item_access};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/libraries", get(list_libraries))
        .route("/libraries/offline", get(offline_libraries))
        .route("/items", get(list_items))
        .route("/items/{id}", get(get_item))
        .route("/series", get(list_series))
        .route("/series/{name}/related", get(related_series))
        .route("/series/{name}/details", get(super::titles::series_details))
}

/// Libraries this user can see. Paths are server internals, so they're only shown to admins.
async fn list_libraries(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<Library>>> {
    let allowed = allowed_libraries(&state, me.user.id).await?;
    let mut libs: Vec<Library> = state
        .db
        .libraries()
        .await?
        .into_iter()
        .filter(|l| allowed.as_ref().is_none_or(|a| a.contains(&l.id)))
        .collect();
    if !me.is_admin() {
        for l in &mut libs {
            l.folders.clear();
        }
    }
    Ok(Json(libs))
}

#[derive(Serialize)]
struct ItemWithProgress {
    #[serde(flatten)]
    item: Item,
    progress: Option<super::watch::Progress>,
}

async fn list_items(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Query(mut filter): Query<ItemFilter>,
) -> ApiResult<Json<Vec<ItemWithProgress>>> {
    filter.allowed_libraries = allowed_libraries(&state, me.user.id).await?;
    let states = super::watch::states_by_key(&state, me.user.id).await?;
    let mut items = state.db.items(&filter).await?;
    episode_stills(&state, &mut items).await;
    Ok(Json(
        items
            .into_iter()
            .map(|item| {
                let progress = states.get(&super::watch::watch_key(&item)).map(super::watch::Progress::from);
                ItemWithProgress { item, progress }
            })
            .collect(),
    ))
}

/// How long a list waits for episode stills it hasn't cached yet; the rest keep downloading in
/// the background and show next time.
const STILLS_WAIT: std::time::Duration = std::time::Duration::from_secs(4);

/// Episodes carry TMDB's still path; swap it for the cached image key (fetching any not cached
/// yet), or nothing while it isn't available.
async fn episode_stills(state: &AppState, items: &mut [Item]) {
    use panda_metadata::ImageSize;
    let images = &state.images;
    let key = |path: &str| images.cache_key(ImageSize::Still, path);
    let cached = |k: &str| images.path_for_key(k).is_some_and(|p| p.exists());
    let missing: std::collections::BTreeSet<String> = items
        .iter()
        .filter_map(|i| i.episode_still.clone())
        .filter(|p| key(p).is_some_and(|k| !cached(&k)))
        .collect();
    if !missing.is_empty()
        && let Some(tmdb) = state.integrations().tmdb.clone()
    {
        let images = images.clone();
        let job = tokio::spawn(async move {
            futures_util::future::join_all(missing.iter().map(|p| images.fetch(&tmdb, ImageSize::Still, p)))
                .await;
        });
        let _ = tokio::time::timeout(STILLS_WAIT, job).await;
    }
    for i in items.iter_mut() {
        i.episode_still = i.episode_still.take().and_then(|p| key(&p)).filter(|k| cached(k));
    }
}

/// The libraries this profile can see whose storage is offline right now (names only).
async fn offline_libraries(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<String>>> {
    let allowed = allowed_libraries(&state, me.user.id).await?;
    Ok(Json(
        state
            .db
            .libraries()
            .await?
            .into_iter()
            .filter(|l| allowed.as_ref().is_none_or(|a| a.contains(&l.id)))
            .filter(|l| crate::services::library_health::is_offline(&state, l.id))
            .map(|l| l.name)
            .collect(),
    ))
}

async fn list_series(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<SeriesSummary>>> {
    let allowed = allowed_libraries(&state, me.user.id).await?;
    Ok(Json(crate::catalog::series(&state, allowed.as_deref()).await?))
}

impl super::titles::Rankable for SeriesSummary {
    fn genres(&self) -> Option<&str> {
        self.genres.as_deref()
    }
    fn rating(&self) -> Option<f64> {
        self.rating
    }
    fn finished(&self) -> bool {
        false
    }
}

/// Shows like this one, from the libraries this user can see.
async fn related_series(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
) -> ApiResult<Json<Vec<SeriesSummary>>> {
    let allowed = allowed_libraries(&state, me.user.id).await?;
    let target =
        crate::catalog::find_series(&state, allowed.as_deref(), &name).await?.ok_or(ApiError::NotFound)?;
    let visible: Vec<SeriesSummary> = crate::catalog::series(&state, allowed.as_deref()).await?;
    let genres = target.genres.clone();
    let others = visible.into_iter().filter(|s| s.series != target.series).collect();
    Ok(Json(super::titles::rank_related(genres.as_deref(), others, super::titles::RELATED_LIMIT)))
}

#[derive(Serialize)]
struct ItemDetail {
    #[serde(flatten)]
    item: Item,
    media: Option<MediaInfo>,
}

async fn get_item(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<Json<ItemDetail>> {
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, me.user.id, &item).await?;
    let media = item.probe_json.as_deref().and_then(|j| serde_json::from_str(j).ok());
    Ok(Json(ItemDetail { item, media }))
}
