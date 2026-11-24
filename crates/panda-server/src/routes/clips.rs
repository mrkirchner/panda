//! Preview clips for the TV's home hero and expanded cards (services/clips.rs).
//!
//! - `GET /api/titles/{id}/clip`, `GET /api/series/{name}/clip` (user): the clip's signed URL
//!   once it's ready. A title's clip comes from its smallest version (1080p over 4K: quicker to
//!   read and no tone mapping); a show's from its first episode. The first request makes it and
//!   waits up to `CLIP_WAIT`; past that `url` is null and the clip keeps being made, ready for
//!   the next request.
//! - `GET /api/items/{id}/clip` (media, signed): the MP4.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Extension, Json, Router};
use panda_db::{Item, ItemFilter};
use serde::Serialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::playback::load;
use super::titles::find_title;
use crate::auth::middleware::MediaGrant;
use crate::auth::{self, CurrentUser, access, ensure_item_access, with_token};
use crate::error::{ApiError, ApiResult};
use crate::services::clips;
use crate::state::AppState;

/// How long a request waits for a clip being made before answering "not yet".
const CLIP_WAIT: Duration = Duration::from_secs(12);

pub(super) fn user_routes() -> Router<AppState> {
    Router::new().route("/titles/{id}/clip", get(title_clip)).route("/series/{name}/clip", get(series_clip))
}

pub(super) fn media_routes() -> Router<AppState> {
    Router::new().route("/items/{id}/clip", get(clip_file))
}

#[derive(Serialize)]
struct ClipUrl {
    /// Signed MP4 URL; null while the clip is still being made (or can't be).
    url: Option<String>,
}

async fn title_clip(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<ClipUrl>> {
    let title = find_title(&state, me.user.id, &id).await?;
    // Smallest version: lowest resolution, then smallest file.
    let item_id = title
        .versions
        .iter()
        .min_by_key(|v| (v.height.unwrap_or(i64::MAX), v.size_bytes))
        .map(|v| v.item_id)
        .ok_or(ApiError::NotFound)?;
    clip_url(&state, (&me.user).into(), item_id).await
}

async fn series_clip(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
) -> ApiResult<Json<ClipUrl>> {
    super::titles::visible_series(&state, me.user.id, &name).await?;
    let filter =
        access(&state, me.user.id).await?.filter(ItemFilter { series: Some(name), ..ItemFilter::default() });
    let items = state.db.items(&filter).await?;
    let item_id = first_episode(&items).ok_or(ApiError::NotFound)?;
    clip_url(&state, (&me.user).into(), item_id).await
}

/// The show's first episode (season 1 before specials), smallest version of it.
fn first_episode(items: &[Item]) -> Option<i64> {
    pick_first(items.iter().map(|i| (i.id, i.season, i.episode, i.height, i.size_bytes)))
}

/// `(id, season, episode, height, size)`: the lowest real season and episode, then the
/// lowest resolution and smallest file.
fn pick_first(items: impl Iterator<Item = (i64, Option<i64>, Option<i64>, Option<i64>, i64)>) -> Option<i64> {
    items
        .min_by_key(|&(_, season, episode, height, size)| {
            let season = season.unwrap_or(i64::MAX);
            (season < 1, season, episode.unwrap_or(i64::MAX), height.unwrap_or(i64::MAX), size)
        })
        .map(|(id, ..)| id)
}

async fn clip_url(state: &AppState, who: auth::Signee, item_id: i64) -> ApiResult<Json<ClipUrl>> {
    let user_id = who.user_id;
    let (item, media) = load(state, item_id).await?;
    ensure_item_access(state, user_id, &item).await?;
    if media.video.is_none() {
        return Ok(Json(ClipUrl { url: None }));
    }
    // Made in its own task: if it outlasts the wait, it carries on for the next request.
    let job = {
        let state = state.clone();
        tokio::spawn(async move { state.clips.ensure(&state, &item, &media).await })
    };
    let ready = match tokio::time::timeout(CLIP_WAIT, job).await {
        Ok(Ok(Ok(_))) => true,
        Ok(Ok(Err(e))) => {
            tracing::debug!(item_id, error = %e, "no preview clip");
            false
        }
        _ => false,
    };
    let url = ready.then(|| {
        let token = auth::sign_media(state, who, &format!("/api/items/{item_id}/"));
        with_token(&format!("/api/items/{item_id}/clip"), &token)
    });
    Ok(Json(ClipUrl { url }))
}

async fn clip_file(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path(id): Path<i64>,
    req: Request,
) -> ApiResult<Response> {
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    let path = clips::path(&state.config.cache_dir(), &item);
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(ApiError::NotFound);
    }
    let res = ServeFile::new(&path).oneshot(req).await.map_err(|e| ApiError::Io(std::io::Error::other(e)))?;
    Ok(res.map(Body::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_episode_prefers_season_one_and_the_smaller_file() {
        let items = [
            (1, Some(0), Some(1), Some(1080), 10), // a special
            (2, Some(2), Some(1), Some(1080), 10),
            (3, Some(1), Some(1), Some(2160), 50), // S01E01 in 4K...
            (4, Some(1), Some(1), Some(1080), 20), // ...and in 1080p
            (5, Some(1), Some(2), Some(720), 5),
        ];
        assert_eq!(pick_first(items.into_iter()), Some(4));
        assert_eq!(first_episode(&[]), None);
    }
}
