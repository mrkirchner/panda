use std::sync::{Arc, RwLock};

use anyhow::Context;
use panda_arr::{AddDefaults, Radarr, Sonarr};
use panda_auth::{MediaSigner, SecretBox};
use panda_db::Db;
use panda_media::caps::{self, Capabilities};
use panda_media::ffmpeg::{self, FfmpegPaths};
use panda_metadata::{ImageCache, Tmdb};
use tokio::sync::Mutex;

use crate::auth::limiter::RateLimiter;
use crate::config::Config;
use crate::services::sessions::{Limits, Sessions};
use crate::services::settings;

/// Shared, cheaply clonable application state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub ffmpeg: Arc<FfmpegPaths>,
    pub caps: Arc<Capabilities>,
    pub images: ImageCache,
    /// External services, rebuilt whenever settings change (no restart needed).
    integrations: Arc<RwLock<Arc<Integrations>>>,
    /// Encrypts secrets at rest. Key file: `data/secret.key`.
    pub(crate) secrets: Arc<SecretBox>,
    /// Signs media URLs for players that can't send auth headers.
    pub(crate) signer: Arc<MediaSigner>,
    pub(crate) limiter: Arc<RateLimiter>,
    /// One-time token required to create the first admin. `None` once setup is done.
    pub(crate) setup_token: Arc<Mutex<Option<String>>>,
    /// Running HLS transcodes.
    pub(crate) sessions: Arc<Sessions>,
    /// Image (PGS) subtitle extraction and parsed cues.
    pub(crate) bitmap_subs: Arc<crate::services::bitmap_subs::BitmapSubs>,
    /// Scrub-thumbnail jobs.
    pub(crate) trickplay: Arc<crate::services::trickplay::Trickplay>,
    /// The library catalog in memory (`crate::catalog`).
    pub(crate) catalog: Arc<crate::catalog::CatalogCell>,
    /// Preview clips for the TV home (services/clips.rs).
    pub(crate) clips: Arc<crate::services::clips::Clips>,
    /// Held while a library scan runs so scans don't overlap.
    pub scan_lock: Arc<Mutex<()>>,
    /// Scans asked for while one was running: a folder, or `None` for everything. The running
    /// scan works through them before it lets go of the lock.
    pub(crate) pending_scans: Arc<std::sync::Mutex<Vec<Option<String>>>>,
    /// Unix time the last scan finished (0 = none yet this run).
    pub(crate) last_scan_at: Arc<std::sync::atomic::AtomicI64>,
    /// Library id -> its storage answered at the last check (`services::library_health`).
    pub(crate) library_online: Arc<std::sync::Mutex<std::collections::HashMap<i64, bool>>>,
    /// Built admin UI to serve at `/`, if present.
    pub(crate) web_dir: Option<std::path::PathBuf>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState").finish_non_exhaustive()
    }
}

/// A Sonarr/Radarr client plus the defaults used when adding media.
#[derive(Debug)]
pub struct Arr<C> {
    pub client: C,
    pub defaults: AddDefaults,
}

#[derive(Debug, Default)]
pub struct Integrations {
    /// `None` when no TMDB token is configured (items keep their parsed names).
    pub tmdb: Option<Arc<Tmdb>>,
    /// The extra metadata providers that are set up (TVmaze, OMDb), adding to TMDB.
    pub(crate) extras:
        std::collections::BTreeMap<panda_metadata::Provider, Arc<crate::services::providers::Extra>>,
    /// Which provider's answer is shown, per kind of data (`services::providers`).
    pub order: panda_metadata::Order,
    /// What the admin switched off per provider (OMDb's Metacritic score, ...).
    pub switches: panda_metadata::Switches,
    /// The HD servers (the original single Radarr/Sonarr settings).
    pub radarr: Option<Arc<Arr<Radarr>>>,
    pub sonarr: Option<Arc<Arr<Sonarr>>>,
    /// Optional 4K servers. Requests go to every configured server of their kind.
    pub radarr_4k: Option<Arc<Arr<Radarr>>>,
    pub sonarr_4k: Option<Arc<Arr<Sonarr>>>,
    /// Bazarr, for "find subtitles" (`None` when it isn't set up).
    pub bazarr: Option<Arc<panda_arr::Bazarr>>,
}

/// Which copy a Radarr/Sonarr server keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Hd,
    #[serde(rename = "4k")]
    Uhd,
}

impl Tier {
    /// For messages: "HD" / "4K".
    pub fn label(self) -> &'static str {
        match self {
            Tier::Hd => "HD",
            Tier::Uhd => "4K",
        }
    }
}

impl Integrations {
    /// Every Radarr, HD first.
    pub fn radarrs(&self) -> Vec<(Tier, Arc<Arr<Radarr>>)> {
        [(Tier::Hd, &self.radarr), (Tier::Uhd, &self.radarr_4k)]
            .into_iter()
            .filter_map(|(t, a)| a.clone().map(|a| (t, a)))
            .collect()
    }

    /// Every Sonarr, HD first.
    pub fn sonarrs(&self) -> Vec<(Tier, Arc<Arr<Sonarr>>)> {
        [(Tier::Hd, &self.sonarr), (Tier::Uhd, &self.sonarr_4k)]
            .into_iter()
            .filter_map(|(t, a)| a.clone().map(|a| (t, a)))
            .collect()
    }
}

impl AppState {
    pub async fn init(config: Config) -> anyhow::Result<Self> {
        for dir in [config.server.data_dir.clone(), config.cache_dir()] {
            tokio::fs::create_dir_all(&dir).await.with_context(|| format!("creating {}", dir.display()))?;
        }
        tracing::info!(
            data = %config.server.data_dir.display(),
            cache = %config.cache_dir().display(),
            transcodes = %config.transcode_dir().display(),
            "storage"
        );
        // Stale segments from a previous run are useless; start clean.
        let _ = tokio::fs::remove_dir_all(config.transcode_dir()).await;

        let secrets =
            SecretBox::load_or_create(&config.secret_key_path()).context("loading data/secret.key")?;
        let signer = MediaSigner::new(secrets.derive_key("panda media url v1"));

        let db = Db::open(&config.database_url()).await.context("opening database")?;
        seed_libraries(&db, &config).await?;

        let ffmpeg =
            ffmpeg::discover(config.ffmpeg.ffmpeg_path.as_deref(), config.ffmpeg.ffprobe_path.as_deref())
                .await
                .context("locating ffmpeg (install jellyfin-ffmpeg or ffmpeg)")?;
        let caps = caps::probe(&ffmpeg).await.context("probing ffmpeg capabilities")?;
        let mut images = ImageCache::new(config.cache_dir().join("images"));
        if caps.has_encoder("libwebp") {
            images = images.with_webp(&ffmpeg.ffmpeg);
        } else {
            tracing::info!("ffmpeg has no libwebp; artwork is cached as JPEG");
        }
        let web_dir = config.resolve_web_dir();
        match &web_dir {
            Some(d) => tracing::info!(dir = %d.display(), "serving admin UI"),
            None if crate::routes::web_bundled() => tracing::info!("serving the built-in admin UI"),
            None => {
                tracing::info!("admin UI not built; run `pnpm dev` in clients/web (http://localhost:5174)");
            }
        }

        let (ahead_secs, keep_secs) = config.transcoding.throttle();
        let seg = panda_media::transcode::SEGMENT_SECS;
        let limits = Limits {
            hardware: config.transcoding.hardware_limit(),
            software: config.transcoding.software_limit(),
            ahead_segments: ahead_secs.div_ceil(seg).max(2),
            keep_segments: keep_secs.div_ceil(seg).max(2),
        };
        tracing::info!(hardware = limits.hardware, software = limits.software, "transcode slots");
        let state = Self {
            config: Arc::new(config),
            db,
            ffmpeg: Arc::new(ffmpeg),
            caps: Arc::new(caps),
            images,
            integrations: Arc::default(),
            secrets: Arc::new(secrets),
            signer: Arc::new(signer),
            limiter: Arc::default(),
            setup_token: Arc::default(),
            sessions: Arc::new(Sessions::new(limits)),
            trickplay: Arc::default(),
            clips: Arc::default(),
            catalog: Arc::default(),
            bitmap_subs: Arc::default(),
            scan_lock: Arc::default(),
            pending_scans: Arc::default(),
            last_scan_at: Arc::default(),
            library_online: Arc::default(),
            web_dir,
        };
        settings::import_from_config(&state).await?;
        state.reload_integrations().await?;
        crate::services::bench::apply_saved_limit(&state).await;
        state.prepare_setup().await?;
        Ok(state)
    }

    /// Current integrations snapshot. Cheap; hold it for the duration of one operation.
    pub fn integrations(&self) -> Arc<Integrations> {
        self.integrations.read().expect("integrations lock poisoned").clone()
    }

    pub(crate) async fn reload_integrations(&self) -> anyhow::Result<()> {
        let next = settings::build_integrations(self).await?;
        if next.tmdb.is_none() {
            tracing::warn!("no TMDB token configured; metadata and artwork are disabled");
        }
        *self.integrations.write().expect("integrations lock poisoned") = Arc::new(next);
        Ok(())
    }

    /// With no accounts yet, print a one-time setup link. Only someone who can read the
    /// server log can create the first admin, so nobody else on the network can race you.
    async fn prepare_setup(&self) -> anyhow::Result<()> {
        if self.db.count_users().await? > 0 {
            return Ok(());
        }
        let token = panda_auth::token::generate()?;
        let has_ui = self.web_dir.is_some() || crate::routes::web_bundled();
        let port = if has_ui { self.config.server.bind.port() } else { 5174 };
        let path = self.config.setup_token_path();
        // Also written to a 0600 file (same exposure as the log) so it isn't lost in scrollback.
        write_private(&path, &token)?;
        let url = format!("http://localhost:{port}/setup?token={token}");
        let bar = "=".repeat(url.len().max(60));
        tracing::warn!(
            "\n{bar}\nNo accounts exist yet. Create the admin account at:\n\n{url}\n\n\
             (From another device, use this server's address instead of localhost. \
             The token is also in {}.)\n{bar}",
            path.display()
        );
        *self.setup_token.lock().await = Some(token);
        Ok(())
    }
}

fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(contents.as_bytes())
}

/// `[[libraries]]` in panda.toml seed an empty database only. After that, libraries are
/// managed in the admin UI (re-adding them on every start would undo deletions).
async fn seed_libraries(db: &Db, config: &Config) -> anyhow::Result<()> {
    if config.libraries.is_empty() {
        return Ok(());
    }
    if db.libraries().await?.is_empty() {
        // Entries sharing a name become one library with several folders.
        let mut by_name: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
        for lib in &config.libraries {
            let path = lib.path.to_string_lossy();
            if let Some(&id) = by_name.get(lib.name.as_str()) {
                db.add_library_folder(id, &path).await?;
            } else {
                let created = db.upsert_library(&lib.name, lib.kind, &path).await?;
                by_name.insert(&lib.name, created.id);
            }
        }
        tracing::info!(count = config.libraries.len(), "imported libraries from panda.toml");
    } else {
        tracing::debug!("libraries are managed in the admin UI; [[libraries]] in panda.toml is ignored");
    }
    Ok(())
}
