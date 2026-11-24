//! What's new for this profile: requests whose title arrived in the library
//! (`services/request_ready.rs`). The apps show them when they open, then mark them seen.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use panda_db::RequestKind;
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
use crate::error::ApiResult;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/notifications", get(list)).route("/notifications/seen", post(seen))
}

/// One arrival, with what the apps need to open it.
#[derive(Serialize)]
struct Arrival {
    /// The request's id (what `seen` takes).
    id: i64,
    kind: RequestKind,
    title: String,
    year: Option<i64>,
    poster: Option<String>,
    /// When it arrived (unix seconds).
    ready_at: Option<i64>,
    /// A movie's title id ("m438631"), or a show's name, to open its page.
    title_id: Option<String>,
    series: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<Arrival>>> {
    let ready = state.db.unseen_ready(me.user.id, crate::services::settings::now() - 7 * 24 * 3600).await?;
    if ready.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let access = crate::auth::access(&state, me.user.id).await?;
    let series = crate::catalog::series(&state, &access).await?;
    Ok(Json(
        ready
            .into_iter()
            .map(|r| Arrival {
                title_id: (r.kind == RequestKind::Movie)
                    .then(|| r.tmdb_id.map(|id| format!("m{id}")))
                    .flatten(),
                series: (r.kind == RequestKind::Series)
                    .then(|| {
                        series
                            .iter()
                            .find(|s| s.tmdb_id.is_some() && s.tmdb_id == r.tmdb_id)
                            .map(|s| s.series.clone())
                    })
                    .flatten(),
                id: r.id,
                kind: r.kind,
                title: r.title,
                year: r.year,
                poster: r.poster,
                ready_at: r.ready_at,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct Seen {
    ids: Vec<i64>,
}

/// Shown: they won't be listed again (only this profile's own; other ids are ignored).
async fn seen(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<Seen>,
) -> ApiResult<StatusCode> {
    for id in body.ids.into_iter().take(200) {
        state.db.mark_ready_seen(me.user.id, id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
