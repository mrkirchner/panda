//! Admin API (`/api/admin/*`, admin role required). Backs the admin web UI.

use std::path::PathBuf;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use panda_arr::{Radarr, Sonarr};
use panda_auth::{password, token};
use panda_db::{Invite, Library, Role, Session, User};
use panda_library::LibraryKind;
use panda_metadata::Tmdb;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::services::scanner;
use crate::services::settings::{self, ArrInput, RADARR, RADARR_4K, SONARR, SONARR_4K, TMDB_TOKEN, now};
use crate::state::AppState;

const INVITE_MAX_DAYS: i64 = 30;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/system", get(system))
        .route("/settings", get(get_settings))
        .route("/settings/tmdb", put(put_tmdb).delete(delete_tmdb))
        .route("/settings/providers/{provider}", put(put_provider).delete(delete_provider))
        .route("/settings/metadata-order", put(put_metadata_order))
        .route("/settings/provider-switch", put(put_provider_switch))
        .route("/settings/storage", get(get_storage).put(put_storage))
        .route("/settings/cleanup", put(put_cleanup))
        .route("/settings/cleanup/run", post(run_cleanup))
        .route("/settings/mail", put(put_mail).delete(delete_mail))
        .route("/settings/bazarr", put(put_bazarr).delete(delete_bazarr))
        .route("/settings/transcoding", put(put_transcoding))
        .route("/bench", get(get_bench).post(start_bench))
        .route("/settings/mail/test", post(test_mail))
        .route("/settings/{service}", put(put_arr).delete(delete_arr))
        .route("/settings/{service}/probe", post(probe_arr))
        .route("/users", get(list_users))
        .route("/users/{id}", axum::routing::patch(update_user).delete(delete_user))
        .route("/users/{id}/password", post(reset_password))
        .route("/users/{id}/pin", put(set_user_pin))
        .route("/users/{id}/sign-in-link", post(user_sign_in_link))
        .route("/invites", get(list_invites).post(create_invite))
        .route("/invites/{id}", delete(delete_invite))
        .route("/sessions", get(list_sessions))
        .route("/sessions/{id}", delete(revoke_session))
        .route("/libraries", get(list_libraries).post(add_library))
        .route("/libraries/{id}", delete(remove_library).patch(rename_library))
        .route("/libraries/{id}/folders", post(add_folder).delete(remove_folder))
        .route("/libraries/{id}/merge", post(merge_library))
        .route("/libraries/scan", post(scan).get(scan_status))
        .route("/fs", get(browse))
        .route("/streams", get(streams))
        .route("/devices", get(list_devices))
        .route("/devices/{id}", delete(delete_device))
}

// ---- system ----

async fn system(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let caps = &state.caps;
    let i = state.integrations();
    let libraries = state.db.library_stats().await?;
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "ffmpeg": {
            "path": state.ffmpeg.ffmpeg,
            "flavor": caps.flavor,
            "version": caps.version,
            "hwaccels": caps.hwaccels,
            "tonemap": caps.tonemap,
        },
        "tmdb": i.tmdb.is_some(),
        "radarr": i.radarr.is_some(),
        "radarr_4k": i.radarr_4k.is_some(),
        "sonarr": i.sonarr.is_some(),
        "sonarr_4k": i.sonarr_4k.is_some(),
        "libraries": libraries,
    })))
}

// ---- settings ----

async fn get_settings(State(state): State<AppState>) -> ApiResult<Json<settings::SettingsView>> {
    Ok(Json(settings::view(&state).await?))
}

#[derive(Deserialize)]
struct TmdbInput {
    read_access_token: String,
}

/// Verify the token against TMDB before storing it (encrypted).
async fn put_tmdb(State(state): State<AppState>, Json(body): Json<TmdbInput>) -> ApiResult<StatusCode> {
    let token = body.read_access_token.trim();
    if token.is_empty() {
        return Err(ApiError::Validation("read_access_token is required".into()));
    }
    Tmdb::new(token).search_movie("Heat", Some(1995)).await.map_err(|e| match e {
        panda_metadata::Error::Status { status, .. } if status.as_u16() == 401 => {
            ApiError::Validation("TMDB rejected this token".into())
        }
        other => ApiError::Metadata(other),
    })?;
    settings::write_secret(&state, TMDB_TOKEN, token).await?;
    reload(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_tmdb(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.db.delete_setting(TMDB_TOKEN).await?;
    reload(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ProviderInput {
    /// For a provider that needs a key (checked with it before saving, stored encrypted).
    api_key: Option<String>,
    /// For one that's just switched on or off.
    enabled: Option<bool>,
}

/// Set up an extra metadata provider (TVmaze, OMDb): its key, or turn it on or off. Titles are
/// then asked about a few at a time after each scan; turning one off re-picks without it.
async fn put_provider(
    State(state): State<AppState>,
    Path(p): Path<panda_metadata::Provider>,
    Json(body): Json<ProviderInput>,
) -> ApiResult<StatusCode> {
    if p.is_base() {
        return Err(ApiError::NotFound); // TMDB has its own route.
    }
    // They're found by the ids TMDB gives, so they need it (turning one off never does).
    if body.enabled != Some(false)
        && let Some(why) = state.integrations().blocked_by(p)
    {
        return Err(ApiError::Validation(why.into()));
    }
    let setting = settings::provider_setting(p);
    if p.spec().key_hint.is_some() {
        let key = body.api_key.as_deref().map(str::trim).unwrap_or_default();
        if key.is_empty() {
            return Err(ApiError::Validation("api_key is required".into()));
        }
        crate::services::providers::Extra::check_key(p, key).await?;
        settings::write_secret(&state, &setting, key).await?;
    } else {
        let on = body.enabled.ok_or_else(|| ApiError::Validation("enabled is required".into()))?;
        settings::write_json(&state, &setting, &on).await?;
    }
    providers_changed(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove an extra provider's key, or turn it off. Its stored answers are kept (unused), so
/// setting it up again needs no new lookups.
async fn delete_provider(
    State(state): State<AppState>,
    Path(p): Path<panda_metadata::Provider>,
) -> ApiResult<StatusCode> {
    if p.is_base() {
        return Err(ApiError::NotFound);
    }
    state.db.delete_setting(&settings::provider_setting(p)).await?;
    providers_changed(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SwitchInput {
    provider: panda_metadata::Provider,
    /// One of the provider's options (`rating.rotten_tomatoes`, `new_episodes`, ...).
    option: String,
    on: bool,
}

/// Turn one thing a provider adds on or off (OMDb's Rotten Tomatoes score, TVmaze's air dates).
/// Takes effect right away from what's stored; nothing is deleted, so turning it back on needs
/// no new lookups.
async fn put_provider_switch(
    State(state): State<AppState>,
    Json(body): Json<SwitchInput>,
) -> ApiResult<StatusCode> {
    // One change at a time, so two quick ones can't both read the old switches and lose one.
    static SAVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_at_a_time = SAVING.lock().await;
    let mut switches = settings::provider_switches(&state).await;
    if !switches.set(body.provider, &body.option, body.on) {
        return Err(ApiError::Validation(format!(
            "{} has no option {:?}",
            body.provider.name(),
            body.option
        )));
    }
    settings::write_json(&state, settings::PROVIDER_SWITCHES, &switches).await?;
    if body.option.starts_with("rating.") {
        // Ratings are read as titles are shown: nothing stored to re-pick. A provider this
        // turns back on still gets asked now.
        reload(&state).await?;
        crate::services::providers::refresh_soon(&state);
    } else {
        providers_changed(&state).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Which provider's answer is shown, per kind of data. Repaired before saving (providers that
/// can't supply a field are dropped, missing ones added at the end); shown values are re-picked
/// from what's stored, with no new lookups.
async fn put_metadata_order(
    State(state): State<AppState>,
    Json(body): Json<panda_metadata::Order>,
) -> ApiResult<Json<panda_metadata::Order>> {
    let order = body.normalized();
    settings::write_json(&state, settings::METADATA_ORDER, &order).await?;
    providers_changed(&state).await?;
    Ok(Json(order))
}

/// A metadata provider setting changed: use it now, and re-pick what's shown in the background.
async fn providers_changed(state: &AppState) -> ApiResult<()> {
    reload(state).await?;
    crate::services::providers::repick(state);
    Ok(())
}

fn arr_key(service: &str) -> ApiResult<&'static str> {
    match service {
        "radarr" => Ok(RADARR),
        "radarr_4k" => Ok(RADARR_4K),
        "sonarr" => Ok(SONARR),
        "sonarr_4k" => Ok(SONARR_4K),
        _ => Err(ApiError::NotFound),
    }
}

#[derive(Serialize)]
struct ArrProbe {
    version: String,
    quality_profiles: Vec<panda_arr::QualityProfile>,
    root_folders: Vec<panda_arr::RootFolder>,
}

async fn probe(key: &str, url: &str, api_key: String) -> ApiResult<ArrProbe> {
    Ok(if key == RADARR || key == RADARR_4K {
        let c = Radarr::new(url, api_key)?;
        let (s, q, r) = tokio::try_join!(c.status(), c.quality_profiles(), c.root_folders())?;
        ArrProbe { version: s.version, quality_profiles: q, root_folders: r }
    } else {
        let c = Sonarr::new(url, api_key)?;
        let (s, q, r) = tokio::try_join!(c.status(), c.quality_profiles(), c.root_folders())?;
        ArrProbe { version: s.version, quality_profiles: q, root_folders: r }
    })
}

#[derive(Deserialize)]
struct ProbeInput {
    url: String,
    /// Omit to use the stored key.
    api_key: Option<String>,
}

/// Test a connection and list quality profiles + root folders (for the setup form).
async fn probe_arr(
    State(state): State<AppState>,
    Path(service): Path<String>,
    Json(body): Json<ProbeInput>,
) -> ApiResult<Json<ArrProbe>> {
    let key = arr_key(&service)?;
    let cfg = settings::merge_arr(
        &state,
        key,
        ArrInput { url: body.url, api_key: body.api_key, quality_profile_id: 0, root_folder: String::new() },
    )
    .await?;
    Ok(Json(probe(key, &cfg.url, cfg.api_key).await?))
}

async fn put_arr(
    State(state): State<AppState>,
    Path(service): Path<String>,
    Json(body): Json<ArrInput>,
) -> ApiResult<StatusCode> {
    let key = arr_key(&service)?;
    let cfg = settings::merge_arr(&state, key, body).await?;
    let p = probe(key, &cfg.url, cfg.api_key.clone()).await?;
    if !p.quality_profiles.iter().any(|q| q.id == cfg.quality_profile_id) {
        return Err(ApiError::Validation("quality_profile_id doesn't exist on that server".into()));
    }
    if !p.root_folders.iter().any(|r| r.path == cfg.root_folder) {
        return Err(ApiError::Validation("root_folder doesn't exist on that server".into()));
    }
    settings::write_arr(&state, key, &cfg).await?;
    reload(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_arr(State(state): State<AppState>, Path(service): Path<String>) -> ApiResult<StatusCode> {
    state.db.delete_setting(arr_key(&service)?).await?;
    reload(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Where Panda keeps things, how much the cache uses, and its ceiling.
async fn get_storage(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let (trimmable, images) = crate::services::cache::usage(&state).await;
    Ok(Json(json!({
        "data_dir": state.config.server.data_dir.display().to_string(),
        "cache_dir": state.config.cache_dir().display().to_string(),
        "cache_max_gb": crate::services::cache::limit_gb(&state).await,
        "cache_used_bytes": trimmable,
        "images_bytes": images,
    })))
}

#[derive(Deserialize)]
struct StorageInput {
    /// 0 = no ceiling.
    cache_max_gb: f64,
}

async fn put_storage(State(state): State<AppState>, Json(body): Json<StorageInput>) -> ApiResult<StatusCode> {
    if !(0.0..=100_000.0).contains(&body.cache_max_gb) {
        return Err(ApiError::Validation("cache_max_gb must be between 0 and 100000".into()));
    }
    state
        .db
        .set_setting(crate::services::cache::CACHE_MAX_GB, &body.cache_max_gb.to_string(), false, now())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_cleanup(
    State(state): State<AppState>,
    Json(body): Json<crate::services::arr_cleanup::CleanupSettings>,
) -> ApiResult<StatusCode> {
    crate::services::arr_cleanup::write(&state, body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Run the cleanup now (with the saved switches); returns how many entries were removed.
async fn run_cleanup(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let settings = crate::services::arr_cleanup::read(&state).await;
    let removed = crate::services::arr_cleanup::sweep(&state, settings)
        .await
        .map_err(|e| ApiError::BadRequest(format!("cleanup failed: {e}")))?;
    Ok(Json(json!({ "removed": removed })))
}

#[derive(Deserialize)]
struct MailInput {
    host: String,
    port: u16,
    security: crate::services::mail::Security,
    #[serde(default)]
    username: String,
    /// Omit to keep the stored one.
    password: Option<String>,
    from: String,
}

/// Connect and sign in to the mail server before saving (encrypted, with its password).
async fn put_mail(State(state): State<AppState>, Json(body): Json<MailInput>) -> ApiResult<StatusCode> {
    let host = body.host.trim().to_string();
    if host.is_empty() || body.port == 0 {
        return Err(ApiError::Validation("host and port are required".into()));
    }
    let password = match body.password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => settings::read_mail(&state).await?.map(|m| m.password).unwrap_or_default(),
    };
    let cfg = crate::services::mail::MailConfig {
        host,
        port: body.port,
        security: body.security,
        username: body.username.trim().to_string(),
        password,
        from: body.from.trim().to_string(),
    };
    cfg.check().await?;
    settings::write_mail(&state, &cfg).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_mail(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.db.delete_setting(settings::MAIL).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MailTest {
    to: String,
}

/// Send a test email with the saved settings.
async fn test_mail(State(state): State<AppState>, Json(body): Json<MailTest>) -> ApiResult<StatusCode> {
    let cfg = settings::read_mail(&state).await?.ok_or(ApiError::NotConfigured("mail"))?;
    cfg.send(body.to.trim(), "Panda test email", "Email from your Panda server works.".into()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct BazarrInput {
    url: String,
    /// Omit (or leave empty) to keep the stored key.
    api_key: Option<String>,
}

/// Save Bazarr after checking it answers with that address and key (never saved otherwise).
async fn put_bazarr(
    State(state): State<AppState>,
    Json(body): Json<BazarrInput>,
) -> ApiResult<Json<serde_json::Value>> {
    let url = body.url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err(ApiError::Validation("Bazarr's address is required".into()));
    }
    let api_key = match body.api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => settings::read_bazarr(&state).await?.map(|b| b.api_key).unwrap_or_default(),
    };
    if api_key.is_empty() {
        return Err(ApiError::Validation("Bazarr's API key is required".into()));
    }
    let client = panda_arr::Bazarr::new(&url, api_key.clone())?;
    let status = client
        .status()
        .await
        .map_err(|e| ApiError::Validation(format!("Bazarr didn't answer with that address and key: {e}")))?;
    settings::write_bazarr(&state, &settings::BazarrConfig { url, api_key }).await?;
    reload(&state).await?;
    Ok(Json(serde_json::json!({ "version": status.bazarr_version })))
}

async fn delete_bazarr(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.db.delete_setting(settings::BAZARR).await?;
    reload(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The stream capacity test: running or not, its lines so far, the last report, what it
/// suggests, and the hardware encode limit now.
async fn get_bench(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let report = crate::services::bench::last_report(&state).await;
    let suggested = report.as_ref().and_then(crate::bench::Report::suggested_hardware_limit);
    Ok(Json(json!({
        "progress": crate::services::bench::current(),
        "report": report,
        "suggested_hardware_limit": suggested,
        "hardware_limit": state.sessions.hardware_limit(),
        "min_speed": crate::bench::MIN_SPEED,
    })))
}

/// Start the test (background; a few minutes). Refused while one runs or anyone streams.
async fn start_bench(State(state): State<AppState>) -> ApiResult<StatusCode> {
    crate::services::bench::start(&state, crate::bench::Options::default())?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
struct TranscodingInput {
    max_hardware: usize,
}

/// Hardware encodes allowed at once: applied now, kept over panda.toml's.
async fn put_transcoding(
    State(state): State<AppState>,
    Json(body): Json<TranscodingInput>,
) -> ApiResult<StatusCode> {
    crate::services::bench::set_hardware_limit(&state, body.max_hardware).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reload(state: &AppState) -> ApiResult<()> {
    state.reload_integrations().await.map_err(|e| ApiError::Internal(e.to_string()))
}

// ---- users ----

#[derive(Serialize)]
struct UserRow {
    #[serde(flatten)]
    user: User,
    /// Libraries this user may see; `null` = all.
    libraries: Option<Vec<i64>>,
}

async fn list_users(State(state): State<AppState>) -> ApiResult<Json<Vec<UserRow>>> {
    let mut rows = Vec::new();
    for user in state.db.users().await? {
        let libraries = state.db.allowed_libraries(&user).await?;
        rows.push(UserRow { user, libraries });
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct UserUpdate {
    role: Option<Role>,
    disabled: Option<bool>,
    /// `[]` = all libraries. Set on an account's owner: it applies to every profile in it.
    libraries: Option<Vec<i64>>,
}

async fn update_user(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
    Json(body): Json<UserUpdate>,
) -> ApiResult<StatusCode> {
    let target = state.db.user(id).await?.ok_or(ApiError::NotFound)?;
    let demoting = body.role == Some(Role::User) && target.role == Role::Admin;
    let disabling = body.disabled == Some(true) && !target.disabled;
    if (demoting || disabling) && id == me.user.id {
        return Err(ApiError::Validation("you can't demote or disable yourself".into()));
    }
    if (demoting || disabling) && target.role == Role::Admin && state.db.count_active_admins().await? <= 1 {
        return Err(ApiError::Validation("there must be at least one active admin".into()));
    }
    if let Some(role) = body.role {
        state.db.set_user_role(id, role).await?;
        // Re-authenticate everywhere with the new privileges.
        state.db.delete_user_sessions(id, None).await?;
    }
    if let Some(disabled) = body.disabled {
        state.db.set_user_disabled(id, disabled).await?;
    }
    if let Some(libs) = body.libraries {
        if target.id != target.account_id {
            return Err(ApiError::Validation("library access is set on the account's owner".into()));
        }
        state.db.set_user_libraries(id, &libs).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// A sign-in link for any profile (the admin shares it; the person picks their own password).
async fn user_sign_in_link(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<super::auth::NewLink>,
) -> ApiResult<Json<Value>> {
    let user = state.db.user(id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(super::auth::new_sign_in_link(&state, &user, &body).await?))
}

#[derive(Deserialize)]
struct PinBody {
    /// 4-8 digits, or null to remove.
    pin: Option<String>,
}

/// Set or clear a profile's PIN (family profiles can't sign in to set their own).
async fn set_user_pin(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<PinBody>,
) -> ApiResult<StatusCode> {
    state.db.user(id).await?.ok_or(ApiError::NotFound)?;
    let hash = match body.pin {
        Some(pin) => Some(
            tokio::task::spawn_blocking(move || password::hash_pin(&pin))
                .await
                .map_err(|e| ApiError::Internal(e.to_string()))??,
        ),
        None => None,
    };
    state.db.set_pin(id, hash.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_user(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    if id == me.user.id {
        return Err(ApiError::Validation("you can't delete yourself".into()));
    }
    let target = state.db.user(id).await?.ok_or(ApiError::NotFound)?;
    if target.id == target.account_id {
        // Deleting an owner deletes the whole account (its profiles and TVs cascade).
        if me.user.account_id == target.id {
            return Err(ApiError::Validation("that would delete your own account".into()));
        }
        if state.db.count_active_admins_outside(target.id).await? < 1 {
            return Err(ApiError::Validation("there must be at least one active admin".into()));
        }
    } else if target.role == Role::Admin && !target.disabled && state.db.count_active_admins().await? <= 1 {
        return Err(ApiError::Validation("there must be at least one active admin".into()));
    }
    state.db.delete_user(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ResetPassword {
    new_password: String,
}

/// Set someone's password (e.g. they forgot it). All their sessions are revoked.
async fn reset_password(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<ResetPassword>,
) -> ApiResult<StatusCode> {
    state.db.user(id).await?.ok_or(ApiError::NotFound)?;
    let pw = body.new_password;
    let hash = tokio::task::spawn_blocking(move || password::hash(&pw))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??;
    state.db.set_password(id, &hash).await?;
    state.db.delete_user_sessions(id, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- invites ----

async fn list_invites(State(state): State<AppState>) -> ApiResult<Json<Vec<Invite>>> {
    Ok(Json(state.db.invites().await?))
}

#[derive(Deserialize)]
struct NewInvite {
    #[serde(default = "default_role")]
    role: Role,
    note: Option<String>,
    #[serde(default = "default_invite_days")]
    expires_days: i64,
    /// Email the invite here (needs mail set up and `base_url`).
    email: Option<String>,
    /// The server's address as the admin UI sees it (the emailed link points there).
    base_url: Option<String>,
}

fn default_role() -> Role {
    Role::User
}

fn default_invite_days() -> i64 {
    7
}

/// The code is returned once. Only its hash is stored, so a lost link means a new invite.
async fn create_invite(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Json(body): Json<NewInvite>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let days = body.expires_days.clamp(1, INVITE_MAX_DAYS);
    let code = token::generate()?;
    let note = body.note.map(|n| n.trim().chars().take(100).collect::<String>()).filter(|n| !n.is_empty());
    let now = now();
    let invite = state
        .db
        .create_invite(
            &token::digest(&code),
            body.role,
            note.as_deref(),
            me.user.id,
            now,
            now + days * 86_400,
        )
        .await?;
    let path = format!("/invite/{code}");
    let mut sent = false;
    if let Some(to) = body.email.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        let to = super::auth::valid_email(to)?;
        let mail = settings::read_mail(&state).await?.ok_or(ApiError::NotConfigured("mail"))?;
        let base = body
            .base_url
            .as_deref()
            .map(|b| b.trim().trim_end_matches('/'))
            .filter(|b| b.starts_with("http://") || b.starts_with("https://"))
            .ok_or_else(|| ApiError::Validation("base_url is required to email an invite".into()))?;
        let from = me.user.display_name.clone().unwrap_or_else(|| me.user.username.clone());
        let text = format!(
            "{from} invited you to their Panda media server.\n\nCreate your account here (the link \
             works once, for {days} days):\n\n{base}{path}\n\nThen sign in on your TV with the username \
             and password you choose.\n"
        );
        mail.send(&to, &format!("{from} invited you to Panda"), text).await?;
        sent = true;
    }
    Ok((StatusCode::CREATED, Json(json!({ "invite": invite, "code": code, "path": path, "sent": sent }))))
}

async fn delete_invite(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if state.db.delete_invite(id).await? { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError::NotFound) }
}

// ---- sessions ----

async fn list_sessions(State(state): State<AppState>) -> ApiResult<Json<Vec<Session>>> {
    Ok(Json(state.db.sessions(None).await?))
}

async fn revoke_session(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if state.db.delete_session(id, None).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// ---- libraries ----

#[derive(Serialize)]
struct LibraryRow {
    #[serde(flatten)]
    library: Library,
    items: i64,
    /// Items TMDB couldn't match.
    unmatched: i64,
}

async fn list_libraries(State(state): State<AppState>) -> ApiResult<Json<Vec<LibraryRow>>> {
    let counts = state.db.library_stats().await?;
    let rows = state
        .db
        .libraries()
        .await?
        .into_iter()
        .map(|library| {
            let s = counts.iter().find(|s| s.id == library.id);
            LibraryRow { items: s.map_or(0, |s| s.items), unmatched: s.map_or(0, |s| s.unmatched), library }
        })
        .collect();
    Ok(Json(rows))
}

async fn scan_status(State(state): State<AppState>) -> Json<Value> {
    let last = state.last_scan_at.load(std::sync::atomic::Ordering::Relaxed);
    Json(json!({
        "scanning": state.scan_lock.try_lock().is_err(),
        "last_scan_at": (last > 0).then_some(last),
        "interval_minutes": state.config.scanning.interval().map(|d| d.as_secs() / 60),
    }))
}

#[derive(Deserialize)]
struct NewLibrary {
    name: String,
    kind: LibraryKind,
    path: PathBuf,
}

async fn add_library(
    State(state): State<AppState>,
    Json(body): Json<NewLibrary>,
) -> ApiResult<(StatusCode, Json<Library>)> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::Validation("name must be 1-64 characters".into()));
    }
    let path = checked_folder(&body.path).await?;
    let libs = state.db.libraries().await?;
    if let Some(owner) = folder_owner(&libs, &path, &body.path) {
        return Err(ApiError::Conflict(format!("that folder already belongs to \"{}\"", owner.name)));
    }
    if libs.iter().any(|l| l.name.eq_ignore_ascii_case(name)) {
        return Err(ApiError::Conflict(format!(
            "a library named \"{name}\" already exists; add the folder to it instead"
        )));
    }
    let lib = state.db.upsert_library(name, body.kind, &path).await?;
    scanner::spawn_scan(state);
    Ok((StatusCode::CREATED, Json(lib)))
}

#[derive(Deserialize)]
struct FolderBody {
    path: PathBuf,
}

/// The library already using `path`. Folders imported from panda.toml are stored as written,
/// so compare both the canonical path and what the admin typed.
fn folder_owner<'a>(libs: &'a [Library], canonical: &str, typed: &std::path::Path) -> Option<&'a Library> {
    let typed = typed.to_string_lossy();
    let typed = typed.trim_end_matches('/');
    libs.iter().find(|l| l.folders.iter().any(|f| f == canonical || f.trim_end_matches('/') == typed))
}

async fn checked_folder(path: &std::path::Path) -> ApiResult<String> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| ApiError::Validation("that folder doesn't exist or isn't readable".into()))?;
    if !tokio::fs::metadata(&path).await?.is_dir() {
        return Err(ApiError::Validation("path must be a folder".into()));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Add another folder to a library (e.g. Movies-HD next to Movies-4K). Same titles merge.
async fn add_folder(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<FolderBody>,
) -> ApiResult<StatusCode> {
    let path = checked_folder(&body.path).await?;
    let libs = state.db.libraries().await?;
    libs.iter().find(|l| l.id == id).ok_or(ApiError::NotFound)?;
    if let Some(owner) = folder_owner(&libs, &path, &body.path) {
        return Err(ApiError::Conflict(format!("that folder already belongs to \"{}\"", owner.name)));
    }
    state.db.add_library_folder(id, &path).await?;
    scanner::spawn_scan(state);
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_folder(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<FolderBody>,
) -> ApiResult<StatusCode> {
    let path = body.path.to_string_lossy();
    let removed = state.db.remove_library_folder(id, &path).await?;
    if removed { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError::NotFound) }
}

#[derive(Deserialize)]
struct RenameBody {
    name: String,
}

async fn rename_library(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<RenameBody>,
) -> ApiResult<StatusCode> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::Validation("name must be 1-64 characters".into()));
    }
    let libs = state.db.libraries().await?;
    if libs.iter().any(|l| l.id != id && l.name.eq_ignore_ascii_case(name)) {
        return Err(ApiError::Conflict(format!("a library named \"{name}\" already exists")));
    }
    state.db.rename_library(id, name).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MergeBody {
    /// Library whose folders and items move into this one (it's removed afterwards).
    from: i64,
}

/// Merge another library into this one, e.g. "Movies 4K" + "Movies HD" -> "Movies".
/// Items keep their metadata and watch history; nothing is rescanned.
async fn merge_library(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<MergeBody>,
) -> ApiResult<StatusCode> {
    let libs = state.db.libraries().await?;
    let into = libs.iter().find(|l| l.id == id).ok_or(ApiError::NotFound)?;
    let from = libs.iter().find(|l| l.id == body.from).ok_or(ApiError::NotFound)?;
    if into.id == from.id {
        return Err(ApiError::Validation("can't merge a library into itself".into()));
    }
    if into.kind != from.kind {
        return Err(ApiError::Validation("both libraries must be the same type".into()));
    }
    state.db.merge_libraries(from.id, into.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes the library from Panda. Media files are never touched.
async fn remove_library(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    // An account limited to just this library would otherwise be left with no limit at all.
    let limited = state.db.sole_library_of(id).await?;
    if !limited.is_empty() {
        return Err(ApiError::Conflict(format!(
            "This is the only library {} can see. Change their library access first.",
            limited.join(", ")
        )));
    }
    let deleted = state.db.delete_library(id).await?;
    if deleted { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError::NotFound) }
}

async fn scan(State(state): State<AppState>) -> StatusCode {
    scanner::spawn_scan(state);
    StatusCode::ACCEPTED
}

// ---- TVs and their profiles ----

async fn list_devices(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let devices: Vec<Value> = state
        .db
        .devices()
        .await?
        .into_iter()
        .map(|(d, profiles)| json!({ "device": d, "profiles": profiles }))
        .collect();
    Ok(Json(json!(devices)))
}

/// Forget a TV entirely: every profile on it is signed out and it must be paired again.
async fn delete_device(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if state.db.delete_device(id).await? { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError::NotFound) }
}

// ---- active streams ----

/// Running HLS sessions (remuxes and transcodes) plus slot usage. Direct play needs no
/// server-side session, so it isn't listed.
async fn streams(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let users = state.db.users().await?;
    let mut list = Vec::new();
    for s in state.sessions.list().await {
        let title = state.db.item(s.info.item_id).await?.map(|i| i.meta_title.unwrap_or(i.title));
        let user = users.iter().find(|u| u.id == s.info.user_id).map(|u| u.username.clone());
        list.push(json!({ "stream": s, "title": title, "user": user }));
    }
    Ok(Json(json!({
        "limits": {
            "hardware": state.sessions.hardware_limit(),
            "software": state.sessions.limits.software,
        },
        "in_use": state.sessions.counts(),
        "streams": list,
    })))
}

// ---- folder browser (library picker) ----

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<PathBuf>,
}

#[derive(Serialize)]
struct Dir {
    name: String,
    path: String,
}

/// List sub-folders of a server path (folders only, hidden ones skipped).
async fn browse(Query(q): Query<BrowseQuery>) -> ApiResult<Json<Value>> {
    let Some(path) = q.path else {
        let roots = ["/Volumes", "/mnt", "/media", "/srv", "/data", "/home", "/"];
        let mut dirs = Vec::new();
        for r in roots {
            if tokio::fs::metadata(r).await.is_ok_and(|m| m.is_dir()) {
                dirs.push(Dir { name: r.to_string(), path: r.to_string() });
            }
        }
        return Ok(Json(json!({ "path": null, "parent": null, "dirs": dirs })));
    };
    let path = tokio::fs::canonicalize(&path).await.map_err(|_| ApiError::NotFound)?;
    let mut entries = tokio::fs::read_dir(&path).await.map_err(|_| ApiError::Forbidden)?;
    let mut dirs = Vec::new();
    while let Some(e) = entries.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !e.file_type().await.is_ok_and(|t| t.is_dir()) {
            continue;
        }
        dirs.push(Dir { path: e.path().to_string_lossy().into_owned(), name });
    }
    dirs.sort_by_key(|d| d.name.to_lowercase());
    Ok(Json(json!({
        "path": path.to_string_lossy(),
        "parent": path.parent().map(|p| p.to_string_lossy().into_owned()),
        "dirs": dirs,
    })))
}
