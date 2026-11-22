//! My List: titles and shows a profile saved for later.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use super::titles::movie_titles;
use crate::auth::{CurrentUser, allowed_libraries};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::now;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/favorites", get(list).put(add).delete(remove))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FavoriteKind {
    /// A movie (title id like `m603`).
    Title,
    /// A show (series name).
    Series,
}

impl FavoriteKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Series => "series",
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct MyListEntry {
    kind: FavoriteKind,
    /// Title id or series name: what the client opens.
    id: String,
    title: String,
    year: Option<i64>,
    poster: Option<String>,
    backdrop: Option<String>,
}

/// The profile's list, newest first, limited to what it may currently see (a title that moved
/// to a restricted library or was deleted simply drops out).
pub(crate) async fn my_list(state: &AppState, user_id: i64) -> ApiResult<Vec<MyListEntry>> {
    let favs = state.db.favorites(user_id).await?;
    if favs.is_empty() {
        return Ok(Vec::new());
    }
    let titles = movie_titles(state, user_id, None).await?;
    let allowed = allowed_libraries(state, user_id).await?;
    let series: Vec<_> = crate::catalog::series(state, allowed.as_deref()).await?;
    Ok(favs
        .into_iter()
        .filter_map(|(kind, reference)| match kind.as_str() {
            "title" => titles.iter().find(|t| t.id == reference).map(|t| MyListEntry {
                kind: FavoriteKind::Title,
                id: t.id.clone(),
                title: t.title.clone(),
                year: t.year,
                poster: t.poster.clone(),
                backdrop: t.backdrop.clone(),
            }),
            _ => series.iter().find(|s| s.series == reference).map(|s| MyListEntry {
                kind: FavoriteKind::Series,
                id: s.series.clone(),
                title: s.meta_title.clone().unwrap_or_else(|| s.series.clone()),
                year: s.year,
                poster: s.poster.clone(),
                backdrop: s.backdrop.clone(),
            }),
        })
        .collect())
}

#[derive(Deserialize)]
struct FavoriteBody {
    kind: FavoriteKind,
    id: String,
}

async fn list(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<MyListEntry>>> {
    Ok(Json(my_list(&state, me.user.id).await?))
}

/// Only things this profile can see can be added.
async fn add(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<FavoriteBody>,
) -> ApiResult<StatusCode> {
    let visible = match body.kind {
        FavoriteKind::Title => movie_titles(&state, me.user.id, None).await?.iter().any(|t| t.id == body.id),
        FavoriteKind::Series => {
            let allowed = allowed_libraries(&state, me.user.id).await?;
            crate::catalog::find_series(&state, allowed.as_deref(), &body.id).await?.is_some()
        }
    };
    if !visible {
        return Err(ApiError::NotFound);
    }
    state.db.add_favorite(me.user.id, body.kind.as_str(), &body.id, now()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<FavoriteBody>,
) -> ApiResult<StatusCode> {
    state.db.remove_favorite(me.user.id, body.kind.as_str(), &body.id).await?;
    Ok(StatusCode::NO_CONTENT)
}
