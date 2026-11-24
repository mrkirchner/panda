//! The web app's push subscriptions (`services/web_push.rs`): the server's public key, and a
//! browser's subscription saved or removed for the signed-in profile.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::services::web_push;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/push/key", get(key))
        .route("/push/subscription", axum::routing::put(subscribe).delete(unsubscribe))
}

async fn key(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "public_key": web_push::public_key(&state).await? })))
}

/// What `PushSubscription.toJSON()` gives in the browser.
#[derive(Deserialize)]
struct Subscription {
    endpoint: String,
    keys: Keys,
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

/// Only a browser push service's address is kept (the server posts to it later).
async fn subscribe(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<Subscription>,
) -> ApiResult<StatusCode> {
    if !web_push::allowed_endpoint(&body.endpoint) || body.endpoint.len() > 2048 {
        return Err(ApiError::Validation("not a browser push service".into()));
    }
    if body.keys.p256dh.len() > 200 || body.keys.auth.len() > 100 {
        return Err(ApiError::Validation("subscription keys are too long".into()));
    }
    let now = crate::services::settings::now();
    state
        .db
        .save_push_subscription(me.user.id, &body.endpoint, &body.keys.p256dh, &body.keys.auth, now)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Unsubscribe {
    endpoint: String,
}

/// Only this profile's own subscription is removed.
async fn unsubscribe(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<Unsubscribe>,
) -> ApiResult<StatusCode> {
    state.db.delete_push_subscription(&body.endpoint, Some(me.user.id)).await?;
    Ok(StatusCode::NO_CONTENT)
}
