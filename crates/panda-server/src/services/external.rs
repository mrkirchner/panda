//! Outside services an admin connects Panda to (Radarr, Sonarr, Bazarr, a mail server): each is a
//! [`Service`] with its [`Spec`], and its settings a [`ServiceConfig`]. Metadata providers
//! (TMDB, TVmaze, OMDb, Fanart.tv) have their own `panda_metadata::providers::Spec`.
//!
//! What every service gets from this, without code of its own:
//! - one setting (`Spec::id`), stored whole as encrypted JSON (it holds a key or a password),
//!   the setting key as the encryption context;
//! - `PUT/DELETE /api/admin/settings/{id}` (routes/admin.rs `put_service`/`delete_service`):
//!   a secret left out keeps the stored one, the settings are checked against the service
//!   before anything is saved, and the server's clients are rebuilt when `Spec::reload`;
//! - the admin's settings view, where secrets are only "is it set";
//! - the `/api/features` flags it turns on (`Spec::features`), so apps offer what it enables.
//!
//! Adding a service: a variant of [`Service`] with its `Spec`, a config type implementing
//! [`ServiceConfig`] (its fields, how admin input merges, how it's checked, what the admin sees),
//! its arm in `routes/admin.rs` `put_service`, its field in `settings::SettingsView` and its card
//! in the admin UI (clients/web). Clients the server keeps go in `settings::build_integrations`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::ArrConfig;
use crate::error::{ApiError, ApiResult};
use crate::services::mail::{MailConfig, Security};
use crate::services::settings::{read_secret, write_secret};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Service {
    Radarr,
    Radarr4k,
    Sonarr,
    Sonarr4k,
    Bazarr,
    Mail,
}

/// Everything Panda knows about a service, in one place.
#[derive(Debug)]
pub(crate) struct Spec {
    /// The setting key and the admin route's name (`/api/admin/settings/{id}`). Never changes:
    /// it's in people's databases and it's the encryption context.
    pub id: &'static str,
    pub name: &'static str,
    /// The `/api/features` flags it turns on (any one service of a flag is enough).
    pub features: &'static [&'static str],
    /// The server keeps a client for it (`Integrations`), rebuilt when it changes.
    pub reload: bool,
}

const RADARR: Spec = Spec { id: "radarr", name: "Radarr", features: &["request_movies"], reload: true };
const RADARR_4K: Spec =
    Spec { id: "radarr_4k", name: "Radarr (4K)", features: &["request_movies"], reload: true };
const SONARR: Spec = Spec { id: "sonarr", name: "Sonarr", features: &["request_shows"], reload: true };
const SONARR_4K: Spec =
    Spec { id: "sonarr_4k", name: "Sonarr (4K)", features: &["request_shows"], reload: true };
const BAZARR: Spec = Spec { id: "bazarr", name: "Bazarr", features: &["subtitle_search"], reload: true };
const MAIL: Spec = Spec { id: "mail", name: "Mail (SMTP)", features: &["mail"], reload: false };

impl Service {
    pub(crate) const ALL: [Service; 6] = [
        Service::Radarr,
        Service::Radarr4k,
        Service::Sonarr,
        Service::Sonarr4k,
        Service::Bazarr,
        Service::Mail,
    ];

    pub(crate) fn spec(self) -> &'static Spec {
        match self {
            Service::Radarr => &RADARR,
            Service::Radarr4k => &RADARR_4K,
            Service::Sonarr => &SONARR,
            Service::Sonarr4k => &SONARR_4K,
            Service::Bazarr => &BAZARR,
            Service::Mail => &MAIL,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        self.spec().id
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.id() == id)
    }

    /// Radarr (HD or 4K): it gets movies. Sonarr gets shows.
    pub(crate) fn is_radarr(self) -> bool {
        matches!(self, Service::Radarr | Service::Radarr4k)
    }
}

/// A service's settings: stored whole (encrypted), taken from admin input, checked against the
/// service before saving, shown to the admin without its secret.
pub(crate) trait ServiceConfig: Serialize + DeserializeOwned + Sized {
    /// What the admin sends. Its secret may be left out (or empty) to keep the stored one.
    type Input: DeserializeOwned;
    /// What the admin sees: everything but the secret, which is only "is it set".
    type View: Serialize;

    /// The settings from `input`, with what's left out taken from `stored`.
    fn merge(input: Self::Input, stored: Option<Self>) -> ApiResult<Self>;
    /// Ask the service (connect, sign in) before anything is saved: `Err` with what to tell the
    /// admin. `Some` is returned to the admin (Bazarr's version).
    async fn check(&self, service: Service) -> ApiResult<Option<Value>>;
    fn view(self) -> Self::View;
}

/// The stored settings, if the service is set up.
pub(crate) async fn read<C: ServiceConfig>(state: &AppState, service: Service) -> ApiResult<Option<C>> {
    match read_secret(state, service.id()).await? {
        Some(json) => Ok(Some(serde_json::from_str(&json).map_err(|e| ApiError::Internal(e.to_string()))?)),
        None => Ok(None),
    }
}

pub(crate) async fn write<C: ServiceConfig>(state: &AppState, service: Service, cfg: &C) -> ApiResult<()> {
    let json = serde_json::to_string(cfg).map_err(|e| ApiError::Internal(e.to_string()))?;
    write_secret(state, service.id(), &json).await
}

/// Admin input -> merged, checked, saved; the server's clients rebuilt when the service has
/// them. Nothing is saved when the check fails.
pub(crate) async fn save<C: ServiceConfig>(
    state: &AppState,
    service: Service,
    input: Value,
) -> ApiResult<Option<Value>> {
    let input: C::Input = serde_json::from_value(input).map_err(|e| ApiError::Validation(e.to_string()))?;
    let cfg = C::merge(input, read::<C>(state, service).await?)?;
    let answer = cfg.check(service).await?;
    write(state, service, &cfg).await?;
    tracing::info!(service = service.spec().name, "connected");
    if service.spec().reload {
        reload(state).await?;
    }
    Ok(answer)
}

pub(crate) async fn remove(state: &AppState, service: Service) -> ApiResult<()> {
    state.db.delete_setting(service.id()).await?;
    if service.spec().reload {
        reload(state).await?;
    }
    Ok(())
}

/// What the admin sees of it (`None`: not set up).
pub(crate) async fn view<C: ServiceConfig>(state: &AppState, service: Service) -> ApiResult<Option<C::View>> {
    Ok(read::<C>(state, service).await?.map(ServiceConfig::view))
}

/// The `/api/features` flags services turn on: each flag true when any service of it is set up.
pub(crate) async fn features(state: &AppState) -> ApiResult<serde_json::Map<String, Value>> {
    let mut flags = serde_json::Map::new();
    for s in Service::ALL {
        let on = state.db.setting(s.id()).await?.is_some();
        for f in s.spec().features {
            let was = flags.get(*f).and_then(Value::as_bool).unwrap_or(false);
            flags.insert((*f).to_string(), Value::Bool(was || on));
        }
    }
    Ok(flags)
}

async fn reload(state: &AppState) -> ApiResult<()> {
    state.reload_integrations().await.map_err(|e| ApiError::Internal(e.to_string()))
}

/// A secret from admin input, else the stored one; `what` names it when neither is there.
fn secret(given: Option<String>, stored: Option<String>, what: &str) -> ApiResult<String> {
    given
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or(stored.filter(|k| !k.is_empty()))
        .ok_or_else(|| ApiError::Validation(format!("{what} is required")))
}

/// `http://host:7878/` -> `http://host:7878`; only http(s).
fn service_url(url: &str) -> ApiResult<String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::Validation("url must start with http:// or https://".into()));
    }
    Ok(url)
}

// ---- Radarr and Sonarr ----

/// Admin input for Radarr/Sonarr. Omit `api_key` to keep the stored one.
#[derive(Debug, Deserialize)]
pub(crate) struct ArrInput {
    pub url: String,
    pub api_key: Option<String>,
    pub quality_profile_id: i64,
    pub root_folder: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArrView {
    pub url: String,
    pub api_key_set: bool,
    pub quality_profile_id: i64,
    pub root_folder: String,
}

/// What a Radarr/Sonarr server answers about itself (the setup form's choices).
#[derive(Debug, Serialize)]
pub(crate) struct ArrProbe {
    pub version: String,
    pub quality_profiles: Vec<panda_arr::QualityProfile>,
    pub root_folders: Vec<panda_arr::RootFolder>,
}

pub(crate) async fn probe_arr(service: Service, url: &str, api_key: String) -> ApiResult<ArrProbe> {
    Ok(if service.is_radarr() {
        let c = panda_arr::Radarr::new(url, api_key)?;
        let (s, q, r) = tokio::try_join!(c.status(), c.quality_profiles(), c.root_folders())?;
        ArrProbe { version: s.version, quality_profiles: q, root_folders: r }
    } else {
        let c = panda_arr::Sonarr::new(url, api_key)?;
        let (s, q, r) = tokio::try_join!(c.status(), c.quality_profiles(), c.root_folders())?;
        ArrProbe { version: s.version, quality_profiles: q, root_folders: r }
    })
}

impl ServiceConfig for ArrConfig {
    type Input = ArrInput;
    type View = ArrView;

    fn merge(input: ArrInput, stored: Option<Self>) -> ApiResult<Self> {
        Ok(ArrConfig {
            url: service_url(&input.url)?,
            api_key: secret(input.api_key, stored.map(|c| c.api_key), "api_key")?,
            quality_profile_id: input.quality_profile_id,
            root_folder: input.root_folder,
        })
    }

    /// It answers, and the quality profile and root folder chosen exist on it.
    async fn check(&self, service: Service) -> ApiResult<Option<Value>> {
        let p = probe_arr(service, &self.url, self.api_key.clone()).await?;
        if !p.quality_profiles.iter().any(|q| q.id == self.quality_profile_id) {
            return Err(ApiError::Validation("quality_profile_id doesn't exist on that server".into()));
        }
        if !p.root_folders.iter().any(|r| r.path == self.root_folder) {
            return Err(ApiError::Validation("root_folder doesn't exist on that server".into()));
        }
        Ok(None)
    }

    fn view(self) -> ArrView {
        ArrView {
            api_key_set: !self.api_key.is_empty(),
            url: self.url,
            quality_profile_id: self.quality_profile_id,
            root_folder: self.root_folder,
        }
    }
}

// ---- Bazarr ----

/// How Panda reaches Bazarr.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BazarrConfig {
    pub url: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BazarrInput {
    url: String,
    /// Omit (or leave empty) to keep the stored key.
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct BazarrView {
    pub url: String,
    pub api_key_set: bool,
}

impl ServiceConfig for BazarrConfig {
    type Input = BazarrInput;
    type View = BazarrView;

    fn merge(input: BazarrInput, stored: Option<Self>) -> ApiResult<Self> {
        if input.url.trim().is_empty() {
            return Err(ApiError::Validation("Bazarr's address is required".into()));
        }
        Ok(BazarrConfig {
            url: service_url(&input.url)?,
            api_key: secret(input.api_key, stored.map(|b| b.api_key), "Bazarr's API key")?,
        })
    }

    async fn check(&self, _: Service) -> ApiResult<Option<Value>> {
        let status =
            panda_arr::Bazarr::new(&self.url, self.api_key.clone())?.status().await.map_err(|e| {
                ApiError::Validation(format!("Bazarr didn't answer with that address and key: {e}"))
            })?;
        Ok(Some(serde_json::json!({ "version": status.bazarr_version })))
    }

    fn view(self) -> BazarrView {
        BazarrView { api_key_set: !self.api_key.is_empty(), url: self.url }
    }
}

// ---- Mail ----

#[derive(Debug, Deserialize)]
pub(crate) struct MailInput {
    host: String,
    port: u16,
    security: Security,
    #[serde(default)]
    username: String,
    /// Omit to keep the stored one.
    password: Option<String>,
    from: String,
}

/// Mail settings as the admin UI sees them (the password only as "is it set").
#[derive(Debug, Serialize)]
pub(crate) struct MailView {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password_set: bool,
    pub from: String,
}

impl ServiceConfig for MailConfig {
    type Input = MailInput;
    type View = MailView;

    fn merge(input: MailInput, stored: Option<Self>) -> ApiResult<Self> {
        let host = input.host.trim().to_string();
        if host.is_empty() || input.port == 0 {
            return Err(ApiError::Validation("host and port are required".into()));
        }
        // A local relay needs no password: an empty one is allowed.
        let password = match input.password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => stored.map(|m| m.password).unwrap_or_default(),
        };
        Ok(MailConfig {
            host,
            port: input.port,
            security: input.security,
            username: input.username.trim().to_string(),
            password,
            from: input.from.trim().to_string(),
        })
    }

    /// Connect and sign in (no mail sent).
    async fn check(&self, _: Service) -> ApiResult<Option<Value>> {
        MailConfig::check(self).await.map(|()| None)
    }

    fn view(self) -> MailView {
        MailView {
            password_set: !self.password.is_empty(),
            host: self.host,
            port: self.port,
            security: self.security,
            username: self.username,
            from: self.from,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_found_again() {
        for s in Service::ALL {
            assert_eq!(Service::from_id(s.id()), Some(s));
            assert_eq!(Service::ALL.iter().filter(|o| o.id() == s.id()).count(), 1, "{}", s.id());
        }
        assert_eq!(Service::from_id("tmdb"), None);
    }

    #[test]
    fn a_secret_left_out_keeps_the_stored_one() {
        let stored = ArrConfig {
            url: "http://old".into(),
            api_key: "kept".into(),
            quality_profile_id: 1,
            root_folder: "/m".into(),
        };
        let input = ArrInput {
            url: "http://radarr:7878/".into(),
            api_key: Some("  ".into()),
            quality_profile_id: 4,
            root_folder: "/movies".into(),
        };
        let c = ArrConfig::merge(input, Some(stored)).unwrap();
        assert_eq!(
            (c.url.as_str(), c.api_key.as_str(), c.quality_profile_id),
            ("http://radarr:7878", "kept", 4)
        );
        let none = ArrInput {
            url: "http://r".into(),
            api_key: None,
            quality_profile_id: 1,
            root_folder: "/".into(),
        };
        assert!(ArrConfig::merge(none, None).is_err());
    }

    #[test]
    fn views_never_carry_the_secret() {
        let v =
            serde_json::to_value(BazarrConfig { url: "http://b".into(), api_key: "s3cret".into() }.view())
                .unwrap();
        assert!(!v.to_string().contains("s3cret"), "{v}");
        assert_eq!(v["api_key_set"], true);
    }
}
