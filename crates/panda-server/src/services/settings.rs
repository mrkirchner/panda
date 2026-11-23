//! Runtime settings: stored in `SQLite`, secrets encrypted with the `SecretBox`.
//!
//! Secrets never leave the server: the admin API reports whether they're set, not their value.

use std::sync::Arc;

use panda_arr::{AddDefaults, Radarr, Sonarr};
use panda_metadata::Tmdb;
use serde::Serialize;

use crate::config::ArrConfig;
use crate::error::{ApiError, ApiResult};
use crate::services::external::{self, ArrView, BazarrConfig, BazarrView, MailView, Service};
use crate::services::mail::MailConfig;
use crate::state::{AppState, Arr, Integrations};

pub(crate) const TMDB_TOKEN: &str = "tmdb.read_access_token";
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
    for (service, value) in [(Service::Radarr, &cfg.radarr), (Service::Sonarr, &cfg.sonarr)] {
        if let Some(arr) = value
            && state.db.setting(service.id()).await?.is_none()
        {
            external::write(state, service, arr).await?;
            imported.push(service.id());
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
    let radarr_at = async |service| -> anyhow::Result<Option<Arc<Arr<Radarr>>>> {
        Ok(match external::read::<ArrConfig>(state, service).await.map_err(|e| anyhow::anyhow!("{e}"))? {
            Some(c) => {
                Some(Arc::new(Arr { client: Radarr::new(&c.url, c.api_key.clone())?, defaults: arr(c) }))
            }
            None => None,
        })
    };
    let sonarr_at = async |service| -> anyhow::Result<Option<Arc<Arr<Sonarr>>>> {
        Ok(match external::read::<ArrConfig>(state, service).await.map_err(|e| anyhow::anyhow!("{e}"))? {
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
        radarr: radarr_at(Service::Radarr).await?,
        radarr_4k: radarr_at(Service::Radarr4k).await?,
        sonarr: sonarr_at(Service::Sonarr).await?,
        sonarr_4k: sonarr_at(Service::Sonarr4k).await?,
        bazarr: match external::read::<BazarrConfig>(state, Service::Bazarr)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
        {
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
        radarr: external::view::<ArrConfig>(state, Service::Radarr).await?,
        radarr_4k: external::view::<ArrConfig>(state, Service::Radarr4k).await?,
        sonarr: external::view::<ArrConfig>(state, Service::Sonarr).await?,
        sonarr_4k: external::view::<ArrConfig>(state, Service::Sonarr4k).await?,
        cleanup: crate::services::arr_cleanup::read(state).await,
        bazarr: external::view::<BazarrConfig>(state, Service::Bazarr).await?,
        mail: external::view::<MailConfig>(state, Service::Mail).await?,
    })
}
