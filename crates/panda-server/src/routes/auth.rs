//! Setup, login, invites, TV device sign-in, and self-service session management.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use panda_auth::{password, token};
use panda_db::{DevicePoll, Session, SessionKind, User};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::limiter::Limit;
use crate::auth::{self, BROWSER_SESSION_SECS, ClientIp, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::now;
use crate::state::AppState;

const LOGIN_PER_IP: Limit = Limit::per_minutes(20, 15);
const LOGIN_PER_USER: Limit = Limit::per_minutes(5, 15);
const SIGNUP_PER_IP: Limit = Limit::per_minutes(10, 15);
const DEVICE_START_PER_IP: Limit = Limit::per_minutes(10, 15);
const DEVICE_POLL_PER_IP: Limit = Limit::per_minutes(300, 15);
const DEVICE_APPROVE_PER_USER: Limit = Limit::per_minutes(10, 15);
const DEVICE_CODE_SECS: i64 = 10 * 60;
const DEVICE_POLL_INTERVAL_SECS: u64 = 5;
/// PINs are short, so attempts are tightly limited per profile on each device and per device.
const PIN_PER_PROFILE: Limit = Limit::per_minutes(5, 15);
const SWITCH_PER_DEVICE: Limit = Limit::per_minutes(30, 15);
/// Adding profiles from a TV: plenty for a family, not for filling the database.
const NEW_PROFILE_PER_IP: Limit = Limit::per_minutes(20, 15);

pub(super) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/auth/device/profiles", post(device_profiles))
        .route("/auth/device/profiles/new", post(device_new_profile))
        .route("/auth/device/switch", post(device_switch))
        .route("/setup", get(setup_status).post(setup))
        // Public on purpose: the credit text each metadata provider's terms ask apps to show,
        // needed on screens a TV shows before anyone has picked a profile (About).
        .route("/credits", get(credits))
        .route("/info", get(info))
        .route("/auth/login", post(login))
        .route("/auth/invite/check", post(invite_check))
        .route("/auth/invite/accept", post(invite_accept))
        .route("/auth/device/start", post(device_start))
        .route("/auth/device/poll", post(device_poll))
        .route("/auth/device/login", post(device_login))
        .route("/auth/sign-in-link/check", post(sign_in_link_check))
        .route("/auth/sign-in-link/use", post(sign_in_link_use))
}

pub(super) fn user_routes() -> Router<AppState> {
    Router::new()
        .route("/auth/me", get(me))
        .route("/auth/logout", post(logout))
        .route("/auth/password", post(change_password))
        .route("/auth/sessions", get(my_sessions))
        .route("/auth/sessions/{id}", delete(revoke_my_session))
        .route("/auth/device/approve", post(device_approve))
        .route("/auth/pin", put(set_pin).get(pin_status))
        .route("/features", get(features))
        .route("/auth/profile/pin", put(set_profile_pin))
        .route("/auth/profile/sign-in-link", post(my_sign_in_link))
        .route("/auth/profile/sign-in", delete(turn_off_sign_in))
        .route("/auth/profile", axum::routing::patch(update_profile).delete(delete_profile))
        .route("/auth/device/register", post(device_register))
        .route("/auth/device/from-browser", post(device_from_browser))
}

/// Most profiles an account holds (its owner included): what "Who's watching?" shows.
pub(crate) const MAX_PROFILES: i64 = 8;

/// Refuse a new profile once the account is full.
pub(crate) async fn ensure_account_room(state: &AppState, account_id: i64) -> ApiResult<()> {
    if state.db.count_account_profiles(account_id).await? >= MAX_PROFILES {
        return Err(ApiError::Conflict(format!("an account can have at most {MAX_PROFILES} profiles")));
    }
    Ok(())
}

fn limit(state: &AppState, key: &str, l: Limit) -> ApiResult<()> {
    state.limiter.hit(key, l).map_err(ApiError::TooManyRequests)
}

/// 3-32 chars of letters, digits, `.`, `_`, `-`. Keeps names unambiguous in UIs and logs.
pub(crate) fn validate_username(name: &str) -> ApiResult<String> {
    let name = name.trim();
    let ok = (3..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok {
        Ok(name.to_string())
    } else {
        Err(ApiError::Validation("username must be 3-32 letters, digits, '.', '_' or '-'".into()))
    }
}

/// Argon2id is deliberately slow; never run it on the async executor.
async fn hash_password(pw: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || password::hash(&pw))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .map_err(ApiError::from)
}

async fn verify_password(pw: String, phc: String) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || password::verify(&pw, &phc))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|s| s.chars().take(120).collect())
}

/// JSON body + `Set-Cookie` for a new browser session.
fn with_session_cookie(
    state: &AppState,
    headers: &HeaderMap,
    raw_token: &str,
    body: impl Serialize,
) -> ApiResult<Response> {
    let cookie = auth::session_cookie(state, headers, raw_token, BROWSER_SESSION_SECS);
    let mut res = Json(body).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|e| ApiError::Internal(e.to_string()))?,
    );
    Ok(res)
}

// ---- setup ----

async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({ "needs_setup": state.db.count_users().await? == 0 })))
}

#[derive(Deserialize)]
struct SetupBody {
    /// From the setup link printed in the server log.
    token: String,
    username: String,
    password: String,
}

async fn setup(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<SetupBody>,
) -> ApiResult<Response> {
    auth::require_safe_transport(&state, ip, &headers)?;
    limit(&state, &ip.key("setup"), SIGNUP_PER_IP)?;
    {
        let expected = state.setup_token.lock().await;
        let Some(expected) = expected.as_deref() else {
            return Err(ApiError::Conflict("setup has already been completed".into()));
        };
        if !token::ct_eq(expected, body.token.trim()) {
            return Err(ApiError::Forbidden);
        }
    }
    let username = validate_username(&body.username)?;
    let hash = hash_password(body.password).await?;
    let user = state
        .db
        .create_first_admin(&username, &hash, now())
        .await?
        .ok_or_else(|| ApiError::Conflict("setup has already been completed".into()))?;
    *state.setup_token.lock().await = None;
    let _ = tokio::fs::remove_file(state.config.setup_token_path()).await;
    tracing::info!(user = %user.username, "setup complete: first admin created");

    let raw =
        auth::start_session(&state, user.id, SessionKind::Browser, user_agent(&headers).as_deref()).await?;
    with_session_cookie(&state, &headers, &raw, json!({ "user": user }))
}

// ---- login / logout ----

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    let user = check_password(&state, &ip, &headers, &body.username, body.password).await?;
    let raw =
        auth::start_session(&state, user.id, SessionKind::Browser, user_agent(&headers).as_deref()).await?;
    with_session_cookie(&state, &headers, &raw, json!({ "user": user }))
}

/// Username and password, rate limited per IP and per username. Unknown names take as long as
/// wrong passwords; profiles without a password (made on a TV) never sign in this way.
async fn check_password(
    state: &AppState,
    ip: &ClientIp,
    headers: &HeaderMap,
    username: &str,
    pw: String,
) -> ApiResult<User> {
    auth::require_safe_transport(state, *ip, headers)?;
    limit(state, &ip.key("login"), LOGIN_PER_IP)?;
    let user_key = format!("login-user:{}", username.trim().to_lowercase());
    // Counted before the (slow) check, so simultaneous guesses can't all slip under the limit;
    // a correct password clears it. Only attempts from outside count toward locking a name:
    // a stranger can't lock you out at home (home attempts are limited per address).
    if !ip.is_local() {
        state.limiter.hit(&user_key, LOGIN_PER_USER).map_err(ApiError::TooManyRequests)?;
    }

    let creds = state.db.credentials(username.trim()).await?;
    // Always run one Argon2 verification so unknown usernames take as long as wrong passwords.
    let phc = creds.as_ref().map_or_else(|| password::dummy_hash().to_string(), |c| c.password_hash.clone());
    let valid = verify_password(pw, phc).await?;
    let Some(creds) = creds.filter(|c| valid && !c.disabled && !c.managed) else {
        return Err(ApiError::InvalidCredentials);
    };
    state.limiter.clear(&user_key);
    state.db.user(creds.id).await?.ok_or(ApiError::InvalidCredentials)
}

async fn logout(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    state.db.delete_session(me.session_id, Some(me.user.id)).await?;
    let mut res = StatusCode::NO_CONTENT.into_response();
    let clear = auth::session_cookie(&state, &headers, "", 0);
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear).map_err(|e| ApiError::Internal(e.to_string()))?,
    );
    Ok(res)
}

#[derive(Serialize)]
struct Me {
    user: User,
    session_id: i64,
    /// Append as `?t=` to `/api/images/{key}` URLs (image loaders can't send headers).
    image_token: String,
}

async fn me(State(state): State<AppState>, Extension(me): Extension<CurrentUser>) -> Json<Me> {
    let image_token = auth::image_token(&state, (&me.user).into());
    Json(Me { user: me.user, session_id: me.session_id, image_token })
}

/// Avatar pictures bundled with the TV app (`images/avatars/<id>.svg`).
pub(crate) const AVATARS: [&str; 16] = [
    "fox", "panda", "owl", "cat", "dog", "bear", "rabbit", "penguin", "frog", "lion", "whale", "koala",
    "robot", "alien", "rocket", "cactus",
];
/// Languages the TV app has.
const LANGUAGES: [&str; 2] = ["en", "es"];

/// Fields to change; omitted ones stay. `null` resets to the default.
#[derive(Deserialize)]
#[allow(clippy::option_option)] // absent (keep) vs. null (reset) vs. a value
struct ProfileBody {
    #[serde(default, deserialize_with = "nullable")]
    display_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    language: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    avatar: Option<Option<String>>,
    /// Home preview clips with (quiet) sound.
    #[serde(default)]
    preview_sound: Option<bool>,
}

/// Distinguish "absent" (`None`) from `null` (`Some(None)`).
#[allow(clippy::option_option)]
fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[allow(clippy::option_option, clippy::ref_option)]
fn opt(v: &Option<Option<String>>) -> Option<Option<&str>> {
    v.as_ref().map(|x| x.as_deref())
}

/// An avatar a profile may pick: a bundled picture, or `art:<image key>`, the poster of a movie
/// or show it can see (Edit profile's "From your library").
async fn avatar_allowed(state: &AppState, user_id: i64, avatar: &str) -> ApiResult<bool> {
    if AVATARS.contains(&avatar) {
        return Ok(true);
    }
    let Some(key) = avatar.strip_prefix(AVATAR_ART) else { return Ok(false) };
    let movies = super::titles::movie_titles(state, user_id, None).await?;
    if movies.iter().any(|m| m.poster.as_deref() == Some(key)) {
        return Ok(true);
    }
    let allowed = crate::auth::allowed_libraries(state, user_id).await?;
    let shows = crate::catalog::series(state, allowed.as_deref()).await?;
    Ok(shows.iter().any(|s| s.poster.as_deref() == Some(key)))
}

/// Avatars from a title's artwork: this, then the image key.
const AVATAR_ART: &str = "art:";

/// A profile edits its own display name, language and avatar (from the TV's Edit profile).
async fn update_profile(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<ProfileBody>,
) -> ApiResult<Json<panda_db::User>> {
    let name = match &body.display_name {
        Some(Some(n)) => Some(Some(profile_name(n)?)),
        Some(None) => Some(None),
        None => None,
    };
    if let Some(Some(l)) = &body.language
        && !LANGUAGES.contains(&l.as_str())
    {
        return Err(ApiError::Validation("unknown language".into()));
    }
    if let Some(Some(a)) = &body.avatar
        && !avatar_allowed(&state, me.user.id, a).await?
    {
        return Err(ApiError::Validation("unknown avatar".into()));
    }
    state
        .db
        .update_profile(me.user.id, opt(&name), opt(&body.language), opt(&body.avatar), body.preview_sound)
        .await?;
    let user = state.db.user(me.user.id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(user))
}

/// Delete your own profile (TV Edit profile). An account's owner (its primary profile) can't:
/// that would delete the whole account. Other profiles go with their history, favorites and
/// requests (the foreign keys cascade), and every session they had ends.
async fn delete_profile(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<StatusCode> {
    if me.user.id == me.user.account_id {
        return Err(ApiError::Forbidden);
    }
    state.db.delete_user(me.user.id).await?;
    tracing::info!(user = me.user.id, "profile deleted by its owner");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PasswordBody {
    current_password: String,
    new_password: String,
}

/// Change your own password. Every other session is signed out.
async fn change_password(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> ApiResult<StatusCode> {
    auth::require_safe_transport(&state, ip, &headers)?;
    limit(&state, &format!("password:{}", me.user.id), LOGIN_PER_USER)?;
    let creds = state.db.credentials(&me.user.username).await?.ok_or(ApiError::Unauthorized)?;
    if !verify_password(body.current_password, creds.password_hash).await? {
        return Err(ApiError::InvalidCredentials);
    }
    let hash = hash_password(body.new_password).await?;
    state.db.set_password(me.user.id, &hash).await?;
    state.db.delete_user_sessions(me.user.id, Some(me.session_id)).await?;
    tracing::info!(user = %me.user.username, "password changed; other sessions revoked");
    Ok(StatusCode::NO_CONTENT)
}

async fn my_sessions(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<Vec<Session>>> {
    Ok(Json(state.db.sessions(Some(me.user.id)).await?))
}

async fn revoke_my_session(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    if state.db.delete_session(id, Some(me.user.id)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// ---- invites ----

#[derive(Deserialize)]
struct InviteCheck {
    code: String,
}

/// Codes travel in POST bodies, not URLs, so they don't end up in access logs.
async fn invite_check(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<InviteCheck>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &ip.key("invite"), SIGNUP_PER_IP)?;
    let valid = state.db.invite_valid(&token::digest(body.code.trim()), now()).await?;
    Ok(Json(json!({ "valid": valid })))
}

#[derive(Deserialize)]
struct InviteAccept {
    code: String,
    username: String,
    password: String,
}

async fn invite_accept(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<InviteAccept>,
) -> ApiResult<Response> {
    auth::require_safe_transport(&state, ip, &headers)?;
    limit(&state, &ip.key("invite"), SIGNUP_PER_IP)?;
    let code_hash = token::digest(body.code.trim());
    if !state.db.invite_valid(&code_hash, now()).await? {
        return Err(ApiError::BadRequest("this invite is invalid, used or expired".into()));
    }
    let username = validate_username(&body.username)?;
    let hash = hash_password(body.password).await?;
    let user = match state.db.accept_invite(&code_hash, &username, &hash, now()).await {
        Ok(Some(u)) => u,
        Ok(None) => return Err(ApiError::BadRequest("this invite is invalid, used or expired".into())),
        Err(e) if e.is_unique_violation() => return Err(ApiError::Conflict("that username is taken".into())),
        Err(e) => return Err(e.into()),
    };
    tracing::info!(user = %user.username, role = ?user.role, "invite accepted");
    let raw =
        auth::start_session(&state, user.id, SessionKind::Browser, user_agent(&headers).as_deref()).await?;
    with_session_cookie(&state, &headers, &raw, json!({ "user": user }))
}

// ---- TV device sign-in ----

#[derive(Deserialize)]
struct DeviceStart {
    device_name: String,
    /// An already-paired TV adding another profile sends its device credential.
    device_token: Option<String>,
}

async fn device_start(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<DeviceStart>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &ip.key("device-start"), DEVICE_START_PER_IP)?;
    let name: String = body.device_name.trim().chars().take(64).collect();
    if name.is_empty() {
        return Err(ApiError::Validation("device_name is required".into()));
    }
    let device_id = match body.device_token.as_deref() {
        Some(t) => Some(device_from_token(&state, t).await?.id),
        None => None,
    };
    let device_code = token::generate()?;
    let now = now();
    // User codes are short, so retry on the (unlikely) collision.
    for _ in 0..3 {
        let user_code = token::user_code()?;
        match state
            .db
            .create_device_code(
                &token::digest(&device_code),
                &user_code,
                &name,
                device_id,
                now,
                now + DEVICE_CODE_SECS,
            )
            .await
        {
            Ok(()) => {
                return Ok(Json(json!({
                    "device_code": device_code,
                    "user_code": user_code,
                    "verification_path": "/link",
                    "expires_in": DEVICE_CODE_SECS,
                    "interval": DEVICE_POLL_INTERVAL_SECS,
                })));
            }
            Err(e) if e.is_unique_violation() => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::Internal("could not allocate a device code".into()))
}

#[derive(Deserialize)]
struct DevicePollBody {
    device_code: String,
}

async fn device_poll(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<DevicePollBody>,
) -> ApiResult<Response> {
    limit(&state, &ip.key("device-poll"), DEVICE_POLL_PER_IP)?;
    match state.db.poll_device_code(&token::digest(body.device_code.trim()), now()).await? {
        DevicePoll::Pending => {
            Ok((StatusCode::ACCEPTED, Json(json!({ "status": "pending" }))).into_response())
        }
        DevicePoll::Invalid => {
            Ok((StatusCode::GONE, Json(json!({ "error": "code expired, start again" }))).into_response())
        }
        DevicePoll::Approved { user_id, device_name, device_id } => {
            let user = state.db.user(user_id).await?.filter(|u| !u.disabled).ok_or(ApiError::Unauthorized)?;
            let (raw, device_token) = pair_device(&state, &user, &device_name, device_id).await?;
            tracing::info!(user = %user.username, device = %device_name, "profile signed in on device");
            Ok(Json(
                json!({ "status": "approved", "token": raw, "device_token": device_token, "user": user }),
            )
            .into_response())
        }
    }
}

/// Sign `user` in on a TV: the first time, create the device (in the user's account) and its
/// credential (returned once, stored hashed); a paired TV only accepts a profile of its own
/// account, never mixing accounts. Returns the profile session token and any new credential.
async fn pair_device(
    state: &AppState,
    user: &User,
    device_name: &str,
    device_id: Option<i64>,
) -> ApiResult<(String, Option<String>)> {
    let now = now();
    // First pairing creates the device (in the approver's account) and its credential,
    // shown once and stored hashed. A paired TV signing someone in again only accepts a
    // profile of its own account: a TV never mixes accounts.
    let (device_id, device_token) = if let Some(id) = device_id {
        let device = state.db.device(id).await?.ok_or(ApiError::Unauthorized)?;
        if device.account_id != user.account_id {
            return Err(ApiError::Forbidden);
        }
        (id, None)
    } else {
        let secret = token::generate()?;
        (
            state.db.create_device(&token::digest(&secret), device_name, user.account_id, now).await?,
            Some(secret),
        )
    };
    let raw = token::generate()?;
    state
        .db
        .start_device_session(
            device_id,
            user.id,
            &token::digest(&raw),
            device_name,
            now,
            now + auth::DEVICE_SESSION_SECS,
        )
        .await?;
    Ok((raw, device_token))
}

#[derive(Deserialize)]
struct DeviceLogin {
    username: String,
    password: String,
    device_name: String,
    /// A TV that's already paired sends its credential (signing someone of its account in).
    device_token: Option<String>,
}

/// Sign a TV in with a username and password, typed on the TV: no code to approve elsewhere.
/// Same checks and limits as the web sign-in; the same device pairing as an approved code.
async fn device_login(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<DeviceLogin>,
) -> ApiResult<Json<serde_json::Value>> {
    let device_id = match body.device_token.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(raw) => Some(device_from_token(&state, raw).await?.id),
        None => None,
    };
    let user = check_password(&state, &ip, &headers, &body.username, body.password).await?;
    let name = body.device_name.trim().chars().take(64).collect::<String>();
    let name = if name.is_empty() { "TV".to_string() } else { name };
    let (raw, device_token) = pair_device(&state, &user, &name, device_id).await?;
    tracing::info!(user = %user.username, device = %name, "signed in on a TV with a password");
    Ok(Json(json!({ "token": raw, "device_token": device_token, "user": user })))
}

/// What this server can do, so apps only offer what works: requests per kind (Radarr / Sonarr
/// set up), TMDB extras (cast, suggestions, discovery), and email (links sent, or shown to
/// share). Booleans only, never settings.
async fn features(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let i = state.integrations();
    let mail = crate::services::settings::read_mail(&state).await?.is_some();
    Ok(Json(json!({
        "request_movies": !i.radarrs().is_empty(),
        "request_shows": !i.sonarrs().is_empty(),
        "tmdb": i.tmdb.is_some(),
        "mail": mail,
        "subtitle_search": i.bazarr.is_some(),
    })))
}

/// What a TV app finding servers needs to know this is one: that it's Panda, the computer's
/// name and the version (what the network announcement says anyway). Public, nothing more.
async fn info() -> Json<serde_json::Value> {
    Json(json!({
        "app": "panda",
        "name": crate::services::discovery::server_name(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// The credit each metadata provider in use asks for (name, notice, site): no secrets, only
/// which services are on.
async fn credits(State(state): State<AppState>) -> Json<serde_json::Value> {
    let i = state.integrations();
    Json(json!(
        panda_metadata::Provider::ALL
            .into_iter()
            .filter(|p| i.provider_enabled(*p))
            .map(|p| json!({ "id": p.id(), "name": p.name(), "credit": p.spec().credit, "site": p.spec().site }))
            .collect::<Vec<_>>()
    ))
}

// ---- a profile's own sign-in (email + password it chooses) ----

/// How long a sign-in link works.
const SIGN_IN_LINK_DAYS: i64 = 7;

#[derive(Deserialize)]
pub(crate) struct NewLink {
    /// Who it's for: becomes their sign-in email.
    pub email: String,
    /// The server's address as the app knows it (`http://panda.lan:8096`): the emailed link
    /// points there. Without it, or without mail set up, the link is only returned.
    pub base_url: Option<String>,
}

/// A one-time link for `user`, for `email`, to choose a password. Returned once (only its hash
/// is kept); a new link replaces the old one.
pub(crate) async fn new_sign_in_link(
    state: &AppState,
    user: &User,
    req: &NewLink,
) -> ApiResult<serde_json::Value> {
    if !user.managed {
        return Err(ApiError::Validation("this profile can already sign in".into()));
    }
    let email = valid_email(&req.email)?;
    if state.db.credentials(&email).await?.is_some_and(|c| c.id != user.id) {
        return Err(ApiError::Conflict("that email is already in use".into()));
    }
    let code = token::generate()?;
    let now = now();
    state
        .db
        .create_sign_in_link(user.id, &email, &token::digest(&code), now, now + SIGN_IN_LINK_DAYS * 86_400)
        .await?;
    let path = format!("/sign-in/{code}");
    // Emailed when mail is set up and we know the address to point at; else shared by hand.
    let base = req
        .base_url
        .as_deref()
        .map(|b| b.trim().trim_end_matches('/'))
        .filter(|b| b.starts_with("http://") || b.starts_with("https://"));
    let mut sent = false;
    if let (Some(mail), Some(base)) = (crate::services::settings::read_mail(state).await?, base) {
        let name = user.display_name.clone().unwrap_or_else(|| user.username.clone());
        let body = format!(
            "Hi {name},\n\nYou can now sign in to Panda with this email address. Choose your \
             password here (the link works once, for {SIGN_IN_LINK_DAYS} days):\n\n{base}{path}\n\n\
             Then sign in on any of your household's TVs, or a new one, with {email} and that password.\n"
        );
        mail.send(&email, "Set up your Panda sign-in", body).await?;
        sent = true;
    }
    Ok(json!({
        "code": code,
        "path": path,
        "email": email,
        "sent": sent,
        "expires_in_days": SIGN_IN_LINK_DAYS,
    }))
}

/// A profile (on its TV, signed in as itself) makes its own sign-in link.
async fn my_sign_in_link(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<NewLink>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &format!("sign-in-link:{}", me.user.id), DEVICE_APPROVE_PER_USER)?;
    Ok(Json(new_sign_in_link(&state, &me.user, &body).await?))
}

/// Turn a profile's own sign-in off: its email and password go, and its other sessions end.
/// The account owner always keeps one (it holds the account).
async fn turn_off_sign_in(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<StatusCode> {
    if me.user.id == me.user.account_id {
        return Err(ApiError::Forbidden);
    }
    let secret = token::generate()?;
    let unusable = hash_password(secret).await?;
    state.db.remove_sign_in(me.user.id, &unusable, Some(me.session_id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LinkCheck {
    code: String,
}

/// Whether a sign-in link works, and whose it is (the page greets them by name).
async fn sign_in_link_check(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<LinkCheck>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &ip.key("invite"), SIGNUP_PER_IP)?;
    let link = state.db.sign_in_link(&token::digest(body.code.trim()), now()).await?;
    Ok(Json(match link {
        Some((u, email)) => {
            json!({ "valid": true, "name": u.display_name.unwrap_or(u.username), "email": email })
        }
        None => json!({ "valid": false }),
    }))
}

#[derive(Deserialize)]
struct LinkUse {
    code: String,
    password: String,
}

/// A plausible email address (no mail is sent; it's a sign-in name people remember).
pub(crate) fn valid_email(raw: &str) -> ApiResult<String> {
    let e = raw.trim().to_lowercase();
    let ok = e.len() <= 254
        && !e.chars().any(char::is_whitespace)
        && e.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        });
    if ok { Ok(e) } else { Err(ApiError::Validation("that doesn't look like an email address".into())) }
}

/// Use a sign-in link: the person chooses a password (the email came with the link), and from then on signs in
/// with them (on a TV, which joins their account, or on the website).
async fn sign_in_link_use(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Json(body): Json<LinkUse>,
) -> ApiResult<StatusCode> {
    auth::require_safe_transport(&state, ip, &headers)?;
    limit(&state, &ip.key("invite"), SIGNUP_PER_IP)?;
    let code_hash = token::digest(body.code.trim());
    if state.db.sign_in_link(&code_hash, now()).await?.is_none() {
        return Err(ApiError::BadRequest("this link is invalid, used or expired".into()));
    }
    let hash = hash_password(body.password).await?;
    match state.db.use_sign_in_link(&code_hash, &hash, now()).await {
        Ok(Some(id)) => {
            tracing::info!(user = id, "profile set up its own sign-in");
            Ok(StatusCode::NO_CONTENT)
        }
        Ok(None) => Err(ApiError::BadRequest("this link is invalid, used or expired".into())),
        Err(e) if e.is_unique_violation() => Err(ApiError::Conflict("that email is already in use".into())),
        Err(e) => Err(e.into()),
    }
}

#[derive(Deserialize)]
struct DeviceApprove {
    user_code: String,
}

/// A signed-in person approves the code shown on the TV.
async fn device_approve(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<DeviceApprove>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &format!("device-approve:{}", me.user.id), DEVICE_APPROVE_PER_USER)?;
    let code = token::normalize_user_code(&body.user_code);
    let name = state
        .db
        .approve_device_code(&code, me.user.id, now())
        .await?
        .ok_or_else(|| ApiError::BadRequest("that code is invalid or expired".into()))?;
    Ok(Json(json!({ "device_name": name })))
}

// ---- profiles on a TV ----

async fn device_from_token(state: &AppState, raw: &str) -> ApiResult<panda_db::Device> {
    state.db.device_by_token(&token::digest(raw.trim()), now()).await?.ok_or(ApiError::Unauthorized)
}

#[derive(Deserialize)]
struct DeviceAuth {
    device_token: String,
}

/// The profile picker: the profiles of this TV's account.
async fn device_profiles(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<DeviceAuth>,
) -> ApiResult<Json<serde_json::Value>> {
    limit(&state, &ip.key("device-profiles"), DEVICE_POLL_PER_IP)?;
    let device = device_from_token(&state, &body.device_token).await?;
    let profiles = state.db.device_profiles(device.id).await?;
    // An admin's TV offers its Debug page (testing tools) from Who's watching.
    let admin = state.db.user(device.account_id).await?.is_some_and(|u| u.role == panda_db::Role::Admin);
    Ok(Json(json!({ "device": device, "profiles": profiles, "admin": admin })))
}

#[derive(Deserialize)]
struct NewProfileBody {
    device_token: String,
    name: String,
}

/// Add a profile to this TV's account from "Who's watching?" (anyone with the TV can, like
/// any streaming app; up to the account limit). It has no password: it's only ever used by
/// picking it on the account's TVs.
async fn device_new_profile(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(body): Json<NewProfileBody>,
) -> ApiResult<(StatusCode, Json<User>)> {
    limit(&state, &ip.key("device-new-profile"), NEW_PROFILE_PER_IP)?;
    let device = device_from_token(&state, &body.device_token).await?;
    let name = profile_name(&body.name)?;
    ensure_account_room(&state, device.account_id).await?;
    let user = create_profile(&state, device.account_id, &name).await?;
    tracing::info!(user = %user.username, device = device.id, "profile added on a TV");
    Ok((StatusCode::CREATED, Json(user)))
}

/// A display name: 1-32 characters, no control characters.
fn profile_name(raw: &str) -> ApiResult<String> {
    let n = raw.trim();
    if n.is_empty() || n.chars().count() > 32 || n.chars().any(char::is_control) {
        return Err(ApiError::Validation("name must be 1-32 characters".into()));
    }
    Ok(n.to_string())
}

/// Create a password-less profile in an account. Its username (unique server-wide, only shown
/// to admins) comes from the name plus a random suffix; its stored hash is of a random secret
/// that is immediately discarded, so it can never sign in.
pub(crate) async fn create_profile(state: &AppState, account_id: i64, name: &str) -> ApiResult<User> {
    let base: String =
        name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).take(20).collect();
    let base = if base.is_empty() { "profile".to_string() } else { base };
    let secret = token::generate()?;
    let unusable = tokio::task::spawn_blocking(move || password::hash(&secret))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??;
    for _ in 0..5 {
        let suffix: String = token::generate()?.chars().filter(char::is_ascii_alphanumeric).take(6).collect();
        let username = format!("{base}-{}", suffix.to_ascii_lowercase());
        match state.db.create_managed_profile(account_id, &username, Some(name), &unusable, now()).await {
            Ok(user) => return Ok(user),
            Err(e) if e.is_unique_violation() => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::Internal("could not pick a username".into()))
}

#[derive(Deserialize)]
struct SwitchBody {
    device_token: String,
    user_id: i64,
    pin: Option<String>,
}

/// Switch the TV to another profile. The PIN (if the profile has one) is checked here, on the
/// server; the previous profile's session on this TV ends.
async fn device_switch(
    State(state): State<AppState>,
    Json(body): Json<SwitchBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let device = device_from_token(&state, &body.device_token).await?;
    limit(&state, &format!("switch:{}", device.id), SWITCH_PER_DEVICE)?;
    let profiles = state.db.device_profiles(device.id).await?;
    let profile = profiles.iter().find(|p| p.user_id == body.user_id).ok_or(ApiError::Forbidden)?;
    if profile.has_pin {
        let key = format!("pin:{}:{}", device.id, profile.user_id);
        state.limiter.hit(&key, PIN_PER_PROFILE).map_err(ApiError::TooManyRequests)?;
        let phc = state.db.pin_hash(profile.user_id).await?.ok_or(ApiError::Forbidden)?;
        let pin = body.pin.unwrap_or_default();
        if !verify_password(pin, phc).await? {
            return Err(ApiError::Validation("wrong PIN".into()));
        }
        state.limiter.clear(&key);
    }
    let user = state.db.user(profile.user_id).await?.ok_or(ApiError::Unauthorized)?;
    let raw = token::generate()?;
    let now = now();
    state
        .db
        .start_device_session(
            device.id,
            user.id,
            &token::digest(&raw),
            &device.name,
            now,
            now + auth::DEVICE_SESSION_SECS,
        )
        .await?;
    Ok(Json(json!({ "token": raw, "user": user })))
}

#[derive(Deserialize)]
struct PinBody {
    current_password: String,
    /// 4-8 digits, or null to remove the PIN.
    pin: Option<String>,
}

#[derive(Deserialize)]
struct FromBrowser {
    #[serde(default)]
    device_name: String,
    /// This browser's device credential, when it was paired before (signs a profile in again).
    device_token: Option<String>,
}

/// The TV app opened in a browser that's signed in to Panda (the web's cookie session, same
/// address: `/tv/` beside the admin UI) sets itself up from that sign-in, as a TV does with a
/// password: a device of the account and a session, no typing. Only a browser's cookie
/// session can (a TV's or app's token can't mint more devices); cookie requests are already
/// held to this site's own origin.
async fn device_from_browser(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<FromBrowser>,
) -> ApiResult<Json<serde_json::Value>> {
    if me.via != crate::auth::AuthVia::Cookie {
        return Err(ApiError::Forbidden);
    }
    let device_id = match body.device_token.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(raw) => Some(device_from_token(&state, raw).await?.id),
        None => None,
    };
    let name = body.device_name.trim().chars().take(64).collect::<String>();
    let name = if name.is_empty() { "Browser".to_string() } else { name };
    let (raw, device_token) = pair_device(&state, &me.user, &name, device_id).await?;
    tracing::info!(user = %me.user.username, device = %name, "TV app in a browser signed in from its web session");
    Ok(Json(json!({ "token": raw, "device_token": device_token, "user": me.user })))
}

/// A TV signed in before device pairing existed gets its device credential (shown once, stored
/// hashed). Only an unattached TV session can do this, once; browsers and paired TVs get 409.
async fn device_register(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<serde_json::Value>> {
    let secret = token::generate()?;
    let id = state
        .db
        .promote_session_to_device(me.session_id, &token::digest(&secret), now())
        .await?
        .ok_or_else(|| ApiError::Conflict("this session is not an unpaired TV".into()))?;
    tracing::info!(user = %me.user.username, device = id, "upgraded TV session to a paired device");
    Ok(Json(json!({ "device_token": secret })))
}

#[derive(Deserialize)]
struct ProfilePinBody {
    /// 4-8 digits, or null to remove the PIN.
    pin: Option<String>,
    /// Required when the profile already has a PIN (to change or remove it).
    current_pin: Option<String>,
}

/// Set, change or remove your profile's PIN from a TV (profiles there have no password). A
/// first PIN needs nothing more; changing or removing one needs the current PIN, so someone
/// at a TV left signed in can't strip it. Wrong guesses are limited like PIN entry.
async fn set_profile_pin(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<ProfilePinBody>,
) -> ApiResult<StatusCode> {
    if let Some(phc) = state.db.pin_hash(me.user.id).await? {
        let key = format!("profile-pin:{}", me.user.id);
        state.limiter.hit(&key, PIN_PER_PROFILE).map_err(ApiError::TooManyRequests)?;
        if !verify_password(body.current_pin.unwrap_or_default(), phc).await? {
            return Err(ApiError::Validation("wrong PIN".into()));
        }
        state.limiter.clear(&key);
    }
    let hash = match body.pin {
        Some(pin) => Some(
            tokio::task::spawn_blocking(move || password::hash_pin(&pin))
                .await
                .map_err(|e| ApiError::Internal(e.to_string()))??,
        ),
        None => None,
    };
    state.db.set_pin(me.user.id, hash.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Whether you have a profile PIN (never the PIN or its hash).
async fn pin_status(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({ "has_pin": state.db.pin_hash(me.user.id).await?.is_some() })))
}

/// Set or clear your profile PIN (asked when switching to you on a shared TV).
async fn set_pin(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<PinBody>,
) -> ApiResult<StatusCode> {
    limit(&state, &format!("password:{}", me.user.id), LOGIN_PER_USER)?;
    let creds = state.db.credentials(&me.user.username).await?.ok_or(ApiError::Unauthorized)?;
    if !verify_password(body.current_password, creds.password_hash).await? {
        return Err(ApiError::InvalidCredentials);
    }
    let hash = match body.pin {
        Some(pin) => Some(
            tokio::task::spawn_blocking(move || password::hash_pin(&pin))
                .await
                .map_err(|e| ApiError::Internal(e.to_string()))??,
        ),
        None => None,
    };
    state.db.set_pin(me.user.id, hash.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}
