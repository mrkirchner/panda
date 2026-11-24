//! Profiles' age limits, set by their account's owner (or an admin, `routes/admin.rs`).
//!
//! The account has a parental PIN (set with the owner's password), asked only to change a limit
//! and to leave a limited profile for a less limited one on a device (`routes/auth.rs`
//! `device_switch`). Picking a profile is otherwise as before: the owner needs no PIN of their
//! own. The owner's profile is never limited.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use panda_auth::password;

use crate::auth::CurrentUser;
use crate::auth::limiter::Limit;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// The limits offered (the youngest age a rating may be for): all ages, 7+, 10+, 13+, 16+.
/// None of them is "no limit".
pub(crate) const AGE_LIMITS: [i64; 5] = [0, 7, 10, 13, 16];

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/account/age-limits", get(list))
        .route("/account/age-limits/{id}", put(set))
        .route("/account/parental-pin", put(set_parental_pin))
}

/// A limit as asked for: one of [`AGE_LIMITS`], or none.
pub(crate) fn valid(max_age: Option<i64>) -> ApiResult<Option<i64>> {
    match max_age {
        Some(a) if !AGE_LIMITS.contains(&a) => {
            Err(ApiError::Validation("that isn't one of the age limits".into()))
        }
        a => Ok(a),
    }
}

#[derive(Serialize)]
struct AgeLimits {
    /// The account has a parental PIN (limits can't be set until it does).
    has_parental_pin: bool,
    /// The limits offered.
    limits: [i64; 5],
    profiles: Vec<Profile>,
}

#[derive(Serialize)]
struct Profile {
    user_id: i64,
    name: String,
    avatar: Option<String>,
    max_age: Option<i64>,
}

/// Only the account's owner, signed in as themselves.
fn owner(me: &CurrentUser) -> ApiResult<i64> {
    if me.user.id == me.user.account_id { Ok(me.user.id) } else { Err(ApiError::Forbidden) }
}

/// The account's other profiles and their limits.
async fn list(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<AgeLimits>> {
    let owner = owner(&me)?;
    let profiles = state
        .db
        .account_profiles(owner)
        .await?
        .into_iter()
        .filter(|u| u.id != owner)
        .map(|u| Profile {
            user_id: u.id,
            name: u.display_name.clone().unwrap_or_else(|| u.username.clone()),
            avatar: u.avatar.clone(),
            max_age: u.max_age,
        })
        .collect();
    let has_parental_pin = state.db.parental_pin_hash(owner).await?.is_some();
    Ok(Json(AgeLimits { has_parental_pin, limits: AGE_LIMITS, profiles }))
}

#[derive(Deserialize)]
struct SetLimit {
    /// One of the limits, or null for none.
    max_age: Option<i64>,
    /// The account's parental PIN.
    #[serde(default)]
    pin: String,
}

/// Wrong guesses at a parental PIN, per account.
const PARENTAL_PIN_TRIES: Limit = Limit::per_minutes(5, 15);

/// Check the account's parental PIN (`Conflict` when it has none yet), with a limit on guesses.
pub(crate) async fn check_parental_pin(state: &AppState, account_id: i64, pin: &str) -> ApiResult<()> {
    let phc = state
        .db
        .parental_pin_hash(account_id)
        .await?
        .ok_or_else(|| ApiError::Conflict("set a parental PIN first".into()))?;
    let key = format!("parental-pin:{account_id}");
    state.limiter.hit(&key, PARENTAL_PIN_TRIES).map_err(ApiError::TooManyRequests)?;
    let pin = pin.to_string();
    let ok = tokio::task::spawn_blocking(move || password::verify(&pin, &phc))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !ok {
        return Err(ApiError::Validation("wrong PIN".into()));
    }
    state.limiter.clear(&key);
    Ok(())
}

/// Set (or lift) one profile's limit: the owner's own account's profiles, never the owner's.
async fn set(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
    Json(body): Json<SetLimit>,
) -> ApiResult<StatusCode> {
    let owner = owner(&me)?;
    let max_age = valid(body.max_age)?;
    let target = state.db.user(id).await?.filter(|u| u.account_id == owner).ok_or(ApiError::NotFound)?;
    if target.id == owner {
        return Err(ApiError::Validation("the account's owner isn't limited".into()));
    }
    check_parental_pin(&state, owner, &body.pin).await?;
    state.db.set_max_age(target.id, max_age).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ParentalPinBody {
    /// The owner's password (always accepted), or the current parental PIN.
    current_password: Option<String>,
    current_pin: Option<String>,
    /// 4-8 digits, or null to remove it.
    pin: Option<String>,
}

/// Set, change or remove the account's parental PIN: the owner, with their password (or the
/// current parental PIN to change it).
async fn set_parental_pin(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<ParentalPinBody>,
) -> ApiResult<StatusCode> {
    let owner = owner(&me)?;
    let by_pin = state.db.parental_pin_hash(owner).await?.is_some() && body.current_pin.is_some();
    if by_pin {
        check_parental_pin(&state, owner, body.current_pin.as_deref().unwrap_or_default()).await?;
    } else {
        state
            .limiter
            .hit(&format!("password:{owner}"), PARENTAL_PIN_TRIES)
            .map_err(ApiError::TooManyRequests)?;
        let creds = state.db.credentials(&me.user.username).await?.ok_or(ApiError::Unauthorized)?;
        let pw = body.current_password.unwrap_or_default();
        let ok = tokio::task::spawn_blocking(move || password::verify(&pw, &creds.password_hash))
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        if !ok {
            return Err(ApiError::InvalidCredentials);
        }
    }
    let hash = match body.pin {
        Some(pin) => Some(
            tokio::task::spawn_blocking(move || password::hash_pin(&pin))
                .await
                .map_err(|e| ApiError::Internal(e.to_string()))??,
        ),
        None => None,
    };
    state.db.set_parental_pin(owner, hash.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}
