//! Sonarr/Radarr -> Panda. On import, rescan the affected folder and mark requests available.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use panda_arr::webhook::Payload;
use panda_db::RequestKind;
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::services::scanner;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/webhooks/arr", post(arr_webhook))
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn arr_webhook(
    State(state): State<AppState>,
    Query(q): Query<TokenQuery>,
    Json(payload): Json<Payload>,
) -> ApiResult<StatusCode> {
    // Without a configured token the webhook is disabled: it would otherwise be an
    // unauthenticated trigger for rescans.
    let Some(expected) = &state.config.server.webhook_token else { return Err(ApiError::NotFound) };
    if !q.token.as_deref().is_some_and(|t| panda_auth::token::ct_eq(t, expected)) {
        return Err(ApiError::Unauthorized);
    }

    tracing::info!(event = %payload.event_type, folder = ?payload.changed_folder(), "arr webhook");
    if !payload.is_import() {
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(id) = payload.movie.as_ref().and_then(|m| m.tmdb_id) {
        state.db.fulfill_request(RequestKind::Movie, id).await?;
    }
    if let Some(id) = payload.series.as_ref().and_then(|s| s.tvdb_id) {
        state.db.fulfill_request(RequestKind::Series, id).await?;
    }
    if let Some(folder) = payload.changed_folder() {
        scanner::spawn_scan_for_path(state, folder.to_string());
    }
    Ok(StatusCode::NO_CONTENT)
}
