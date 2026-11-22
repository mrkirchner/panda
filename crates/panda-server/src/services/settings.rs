//! Runtime settings: stored in `SQLite`, secrets encrypted with the `SecretBox`.
//!
//! Secrets never leave the server: the admin API reports whether they're set, not their value.

use std::sync::Arc;

use panda_arr::{AddDefaults, Radarr, Sonarr};
use panda_metadata::Tmdb;
use serde::{Deserialize, Serialize};

use crate::config::ArrConfig;
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, Arr, Integrations};

pub(crate) const TMDB_TOKEN: &str = "tmdb.read_access_token";
pub(crate) const RADARR: &str = "radarr";
pub(crate) const SONARR: &str = "sonarr";
/// Optional second servers for 4K copies; requests go to every server of their kind.
pub(crate) const RADARR_4K: &str = "radarr_4k";
pub(crate) const SONARR_4K: &str = "sonarr_4k";
/// Outgoing mail (SMTP), stored whole as one encrypted JSON blob (it holds the password).
pub(crate) const MAIL: &str = "mail";
/// Bazarr (subtitles): its address and API key, encrypted like the other secrets.
pub(crate) const BAZARR: &str = "bazarr";

/// How Panda reaches Bazarr.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct BazarrConfig {
    pub url: String,
    pub api_key: String,
}

pub(crate) async fn read_bazarr(state: &AppState) -> ApiResult<Option<BazarrConfig>> {
    match read_secret(state, BAZARR).await? {
        Some(json) => Ok(Some(serde_json::from_str(&json).map_err(|e| ApiError::Internal(e.to_string()))?)),
        None => Ok(None),
    }
}

pub(crate) async fn write_bazarr(state: &AppState, cfg: &BazarrConfig) -> ApiResult<()> {
    let json = serde_json::to_string(cfg).map_err(|e| ApiError::Internal(e.to_string()))?;
    write_secret(state, BAZARR, &json).await
}
/// An extra metadata provider's setting: its key (encrypted) for one that needs a key
/// (`omdb.api_key`), else whether it's on (plain `true`/`false`, keyed by its id: `tvmaze`).
pub(crate) fn provider_setting(p: panda_metadata::Provider) -> String {
    if p.spec().key_hint.is_some() { format!("{}.api_key", p.id()) } else { p.id().to_string() }
}

/// The extra providers that are set up, with their clients.
async fn build_extras(
    state: &AppState,
) -> ApiResult<std::collections::BTreeMap<panda_metadata::Provider, Arc<crate::services::providers::Extra>>> {
    use crate::services::providers::Extra;
    let mut extras = std::collections::BTreeMap::new();
    for p in panda_metadata::Provider::extras() {
        let key = provider_setting(p);
        let extra = if p.spec().key_hint.is_some() {
            read_secret(state, &key).await?.and_then(|k| Extra::new(p, Some(&k)))
        } else {
            read_json::<bool>(state, &key).await.then(|| Extra::new(p, None)).flatten()
        };
        if let Some(e) = extra {
            extras.insert(p, Arc::new(e));
        }
    }
    Ok(extras)
}
/// Provider order per kind of data (plain JSON `panda_metadata::Order`).
pub(crate) const METADATA_ORDER: &str = "metadata_order";

/// Per-provider switches (plain JSON `panda_metadata::Switches`: what's turned off).
pub(crate) const PROVIDER_SWITCHES: &str = "provider_switches";

/// A plain (not secret) JSON setting, or the default when it's missing or unreadable.
pub(crate) async fn read_json<T: serde::de::DeserializeOwned + Default>(state: &AppState, key: &str) -> T {
    match state.db.setting(key).await {
        Ok(Some(s)) if !s.encrypted => serde_json::from_str(&s.value).unwrap_or_default(),
        _ => T::default(),
    }
}

pub(crate) async fn write_json<T: Serialize>(state: &AppState, key: &str, value: &T) -> ApiResult<()> {
    let json = serde_json::to_string(value).map_err(|e| ApiError::Internal(e.to_string()))?;
    state.db.set_setting(key, &json, false, now()).await?;
    Ok(())
}

pub(crate) async fn provider_switches(state: &AppState) -> panda_metadata::Switches {
    read_json::<panda_metadata::Switches>(state, PROVIDER_SWITCHES).await.normalized()
}

/// The provider order, repaired (unknown or missing providers fixed), or the default.
pub(crate) async fn metadata_order(state: &AppState) -> panda_metadata::Order {
    read_json::<panda_metadata::Order>(state, METADATA_ORDER).await.normalized()
}

pub(crate) async fn read_mail(state: &AppState) -> ApiResult<Option<crate::services::mail::MailConfig>> {
    match read_secret(state, MAIL).await? {
        Some(json) => Ok(Some(serde_json::from_str(&json).map_err(|e| ApiError::Internal(e.to_string()))?)),
        None => Ok(None),
    }
}

pub(crate) async fn write_mail(state: &AppState, cfg: &crate::services::mail::MailConfig) -> ApiResult<()> {
    let json = serde_json::to_string(cfg).map_err(|e| ApiError::Internal(e.to_string()))?;
    write_secret(state, MAIL, &json).await
}

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Read and decrypt a secret setting. The setting key is the encryption context, so a value
/// can't be swapped into another setting.
pub(crate) async fn read_secret(state: &AppState, key: &str) -> ApiResult<Option<String>> {
    let Some(s) = state.db.setting(key).await? else { return Ok(None) };
    if !s.encrypted {
        return Err(ApiError::Internal(format!("setting {key} is expected to be encrypted")));
    }
    Ok(Some(state.secrets.decrypt(&s.value, key)?))
}

pub(crate) async fn write_secret(state: &AppState, key: &str, value: &str) -> ApiResult<()> {
    let ct = state.secrets.encrypt(value, key)?;
    state.db.set_setting(key, &ct, true, now()).await?;
    Ok(())
}

pub(crate) async fn read_arr(state: &AppState, key: &str) -> ApiResult<Option<ArrConfig>> {
    match read_secret(state, key).await? {
        Some(json) => Ok(Some(serde_json::from_str(&json).map_err(|e| ApiError::Internal(e.to_string()))?)),
        None => Ok(None),
    }
}

/// Sonarr/Radarr settings are stored whole as one encrypted JSON blob (it contains the API key).
pub(crate) async fn write_arr(state: &AppState, key: &str, cfg: &ArrConfig) -> ApiResult<()> {
    let json = serde_json::to_string(cfg).map_err(|e| ApiError::Internal(e.to_string()))?;
    write_secret(state, key, &json).await
}

/// One-time move of secrets from panda.toml into the encrypted store.
pub(crate) async fn import_from_config(state: &AppState) -> anyhow::Result<()> {
    let cfg = &state.config;
    let mut imported = Vec::new();
    if let Some(token) = cfg.tmdb.read_access_token.as_deref().map(str::trim).filter(|t| !t.is_empty())
        && std::env::var_os("PANDA_TMDB_TOKEN").is_none()
        && state.db.setting(TMDB_TOKEN).await?.is_none()
    {
        write_secret(state, TMDB_TOKEN, token).await?;
        imported.push("[tmdb]");
    }
    for (key, value) in [(RADARR, &cfg.radarr), (SONARR, &cfg.sonarr)] {
        if let Some(arr) = value
            && state.db.setting(key).await?.is_none()
        {
            write_arr(state, key, arr).await?;
            imported.push(key);
        }
    }
    if !imported.is_empty() {
        tracing::warn!(
            sections = ?imported,
            "imported secrets from panda.toml into the encrypted settings store. \
             Remove them from panda.toml; manage them in the admin UI from now on"
        );
    }
    Ok(())
}

pub(crate) async fn build_integrations(state: &AppState) -> anyhow::Result<Integrations> {
    // The environment variable wins (useful for containers), but is never persisted.
    let token = match std::env::var("PANDA_TMDB_TOKEN").ok().filter(|t| !t.trim().is_empty()) {
        Some(t) => Some(t.trim().to_string()),
        None => read_secret(state, TMDB_TOKEN).await.map_err(|e| anyhow::anyhow!("{e}"))?,
    };
    let arr =
        |c: ArrConfig| AddDefaults { quality_profile_id: c.quality_profile_id, root_folder: c.root_folder };
    let radarr_at = async |key| -> anyhow::Result<Option<Arc<Arr<Radarr>>>> {
        Ok(match read_arr(state, key).await.map_err(|e| anyhow::anyhow!("{e}"))? {
            Some(c) => {
                Some(Arc::new(Arr { client: Radarr::new(&c.url, c.api_key.clone())?, defaults: arr(c) }))
            }
            None => None,
        })
    };
    let sonarr_at = async |key| -> anyhow::Result<Option<Arc<Arr<Sonarr>>>> {
        Ok(match read_arr(state, key).await.map_err(|e| anyhow::anyhow!("{e}"))? {
            Some(c) => {
                Some(Arc::new(Arr { client: Sonarr::new(&c.url, c.api_key.clone())?, defaults: arr(c) }))
            }
            None => None,
        })
    };
    Ok(Integrations {
        tmdb: token.map(|t| Arc::new(Tmdb::new(t))),
        extras: build_extras(state).await.map_err(|e| anyhow::anyhow!("{e}"))?,
        order: metadata_order(state).await,
        switches: provider_switches(state).await,
        radarr: radarr_at(RADARR).await?,
        radarr_4k: radarr_at(RADARR_4K).await?,
        sonarr: sonarr_at(SONARR).await?,
        sonarr_4k: sonarr_at(SONARR_4K).await?,
        bazarr: match read_bazarr(state).await.map_err(|e| anyhow::anyhow!("{e}"))? {
            Some(c) => Some(Arc::new(panda_arr::Bazarr::new(&c.url, c.api_key)?)),
            None => None,
        },
    })
}

/// What the admin UI sees. Secrets are reduced to "is it set".
#[derive(Debug, Serialize)]
pub(crate) struct SettingsView {
    pub tmdb: TmdbView,
    /// Which provider's answer is shown, per kind of data.
    pub metadata_order: panda_metadata::Order,
    /// The kinds of data in `metadata_order`, with their labels.
    pub metadata_fields: Vec<FieldView>,
    /// Every provider: whether it's on, and its switches.
    pub providers: Vec<ProviderView>,
    pub radarr: Option<ArrView>,
    pub radarr_4k: Option<ArrView>,
    pub sonarr: Option<ArrView>,
    pub sonarr_4k: Option<ArrView>,
    pub mail: Option<MailView>,
    /// Bazarr's address; its key only as "is it set".
    pub bazarr: Option<BazarrView>,
    /// Weekly removal of finished titles from Radarr/Sonarr.
    pub cleanup: crate::services::arr_cleanup::CleanupSettings,
}

/// Bazarr as the admin UI sees it.
#[derive(Debug, Serialize)]
pub(crate) struct BazarrView {
    pub url: String,
    pub api_key_set: bool,
}

/// Mail settings as the admin UI sees them (the password only as "is it set").
#[derive(Debug, Serialize)]
pub(crate) struct MailView {
    pub host: String,
    pub port: u16,
    pub security: crate::services::mail::Security,
    pub username: String,
    pub password_set: bool,
    pub from: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TmdbView {
    pub configured: bool,
    /// `env` when `$PANDA_TMDB_TOKEN` overrides the stored value.
    pub source: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProviderView {
    pub id: panda_metadata::Provider,
    pub name: &'static str,
    /// TMDB: the base (set up with its own card); the others add to it.
    pub base: bool,
    pub about: &'static str,
    pub credit: &'static str,
    pub site: &'static str,
    /// `Some`: it needs the admin's own key (how to get one); `None`: an on/off switch.
    pub key_hint: Option<&'static str>,
    pub enabled: bool,
    /// Why it can't be set up yet ("Set up TMDB first"); the server refuses until then.
    pub blocked_by: Option<&'static str>,
    /// What the admin can switch off for it, and whether each is on.
    pub options: Vec<OptionView>,
}

#[derive(Debug, Serialize)]
pub(crate) struct OptionView {
    pub id: String,
    pub label: String,
    pub on: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct FieldView {
    pub id: panda_metadata::Field,
    pub label: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArrView {
    pub url: String,
    pub api_key_set: bool,
    pub quality_profile_id: i64,
    pub root_folder: String,
}

impl From<ArrConfig> for ArrView {
    fn from(c: ArrConfig) -> Self {
        Self {
            api_key_set: !c.api_key.is_empty(),
            url: c.url,
            quality_profile_id: c.quality_profile_id,
            root_folder: c.root_folder,
        }
    }
}

pub(crate) async fn view(state: &AppState) -> ApiResult<SettingsView> {
    let env = std::env::var("PANDA_TMDB_TOKEN").is_ok_and(|t| !t.trim().is_empty());
    let stored = state.db.setting(TMDB_TOKEN).await?.is_some();
    Ok(SettingsView {
        tmdb: TmdbView {
            configured: env || stored,
            source: if env {
                Some("env")
            } else if stored {
                Some("settings")
            } else {
                None
            },
        },
        metadata_order: state.integrations().order.clone(),
        metadata_fields: panda_metadata::Field::ALL
            .into_iter()
            .map(|f| FieldView { id: f, label: f.label() })
            .collect(),
        providers: {
            let i = state.integrations();
            panda_metadata::Provider::ALL
                .into_iter()
                .map(|p| ProviderView {
                    id: p,
                    name: p.name(),
                    base: p.is_base(),
                    about: p.spec().about,
                    credit: p.spec().credit,
                    site: p.spec().site,
                    key_hint: p.spec().key_hint,
                    enabled: i.provider_enabled(p),
                    blocked_by: i.blocked_by(p),
                    options: p
                        .options()
                        .into_iter()
                        .map(|(id, label)| OptionView { on: i.switches.allows(p, &id), id, label })
                        .collect(),
                })
                .collect()
        },
        radarr: read_arr(state, RADARR).await?.map(ArrView::from),
        radarr_4k: read_arr(state, RADARR_4K).await?.map(ArrView::from),
        sonarr: read_arr(state, SONARR).await?.map(ArrView::from),
        sonarr_4k: read_arr(state, SONARR_4K).await?.map(ArrView::from),
        cleanup: crate::services::arr_cleanup::read(state).await,
        bazarr: read_bazarr(state)
            .await?
            .map(|b| BazarrView { api_key_set: !b.api_key.is_empty(), url: b.url }),
        mail: read_mail(state).await?.map(|m| MailView {
            password_set: !m.password.is_empty(),
            host: m.host,
            port: m.port,
            security: m.security,
            username: m.username,
            from: m.from,
        }),
    })
}

/// Admin input for Sonarr/Radarr. Omit `api_key` to keep the stored one.
#[derive(Debug, Deserialize)]
pub(crate) struct ArrInput {
    pub url: String,
    pub api_key: Option<String>,
    pub quality_profile_id: i64,
    pub root_folder: String,
}

pub(crate) async fn merge_arr(state: &AppState, key: &str, input: ArrInput) -> ApiResult<ArrConfig> {
    let url = input.url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::Validation("url must start with http:// or https://".into()));
    }
    let api_key = match input.api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => read_arr(state, key)
            .await?
            .map(|c| c.api_key)
            .ok_or_else(|| ApiError::Validation("api_key is required".into()))?,
    };
    Ok(ArrConfig {
        url,
        api_key,
        quality_profile_id: input.quality_profile_id,
        root_folder: input.root_folder,
    })
}
