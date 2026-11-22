use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Context;
use panda_library::LibraryKind;
use serde::Deserialize;

/// Loaded from `$PANDA_CONFIG`, else `./panda.toml`. Missing file -> defaults.
/// See `config/panda.example.toml`.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub ffmpeg: FfmpegConfig,
    pub libraries: Vec<LibraryConfig>,
    pub radarr: Option<ArrConfig>,
    pub sonarr: Option<ArrConfig>,
    pub tmdb: TmdbConfig,
    pub transcoding: TranscodingConfig,
    pub scanning: ScanningConfig,
}

/// Background rescans, so new files appear without a Sonarr/Radarr webhook or a manual scan.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ScanningConfig {
    /// Minutes between rescans of every library. 0 turns them off. Default 15. Rescans are
    /// cheap: unchanged files (same size and mtime) are never probed again.
    pub interval_minutes: Option<u64>,
    /// Watch library folders for changes, so files copied in show up within seconds (default
    /// on). The interval scan stays as the backstop (network shares don't always report changes).
    pub watch: Option<bool>,
}

impl ScanningConfig {
    pub fn interval(&self) -> Option<std::time::Duration> {
        match self.interval_minutes.unwrap_or(15) {
            0 => None,
            m => Some(std::time::Duration::from_secs(m * 60)),
        }
    }
}

/// Simultaneous video encodes. Direct play and remuxes are never limited.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct TranscodingConfig {
    /// Hardware encodes (Apple media engine, ...). Default 4: an M4 ran one 4K HDR to
    /// 1080p tone-mapped encode at ~7x real time, so 4 leaves headroom.
    pub max_hardware: Option<usize>,
    /// CPU encodes. Default: one per 4 CPU cores (each software 4K encode uses ~10 cores at
    /// full speed, but only needs ~1x real time).
    pub max_software: Option<usize>,
    /// Pause ffmpeg when it is this far ahead of the viewer (it resumes at half this).
    /// Frees the encoder for other viewers and stops work on movies people abandon. Default 120.
    pub throttle_ahead_secs: Option<u32>,
    /// Delete segments this far behind the viewer to bound disk use. Default 120.
    pub keep_behind_secs: Option<u32>,
}

impl TranscodingConfig {
    pub fn hardware_limit(&self) -> usize {
        self.max_hardware.unwrap_or(4)
    }

    pub fn throttle(&self) -> (u32, u32) {
        (self.throttle_ahead_secs.unwrap_or(120), self.keep_behind_secs.unwrap_or(120))
    }

    pub fn software_limit(&self) -> usize {
        self.max_software
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| (n.get() / 4).max(1)))
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct TmdbConfig {
    /// TMDB "API Read Access Token" (v4 bearer token). `$PANDA_TMDB_TOKEN` overrides this.
    pub read_access_token: Option<String>,
    /// Country for "Popular on <service>" rows in search (ISO 3166-1, e.g. "US", "GB").
    pub region: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    /// What must be kept (database, encryption key). Default: `$PANDA_DATA_DIR`, else the OS's
    /// place for app data (see `default_dirs`).
    pub data_dir: PathBuf,
    /// What can be rebuilt (artwork, subtitles, scrub previews, transcodes). Default:
    /// `$PANDA_CACHE_DIR`, else the OS's cache folder; with `data_dir` set in this file, that
    /// folder (one folder for everything, as before).
    pub cache_dir: Option<PathBuf>,
    /// Transcode segments (busy writes: a fast disk or RAM helps). Default: `<cache>/transcodes`.
    pub transcode_dir: Option<PathBuf>,
    /// Ceiling for what's made on demand (scrub previews, subtitles), in GB; the oldest goes
    /// first. 0 = no ceiling. Artwork isn't trimmed. Default 20.
    pub cache_max_gb: Option<f64>,
    /// Shared secret Sonarr/Radarr must send as `?token=` on webhook calls.
    pub webhook_token: Option<String>,
    /// Trust `X-Forwarded-For` / `X-Forwarded-Proto` (only behind your own reverse proxy).
    pub trust_proxy: bool,
    /// Force the cookie `Secure` flag. Default: on when the request arrived over HTTPS.
    pub secure_cookies: Option<bool>,
    /// Built admin UI (`clients/web/dist`). Default: that path if it exists, else `web/`
    /// next to the binary. Without it, only the API is served (use `pnpm dev` for the UI).
    pub web_dir: Option<PathBuf>,
    /// Announce this server on the local network (mDNS `_panda._tcp`), so TV apps find it
    /// without typing an address. Default on; never when bound to loopback only.
    pub advertise: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: ([0, 0, 0, 0], 8096).into(),
            // Empty: not set (filled in by `Config::load`).
            data_dir: PathBuf::new(),
            cache_dir: None,
            transcode_dir: None,
            cache_max_gb: Some(20.0),
            webhook_token: None,
            trust_proxy: false,
            secure_cookies: None,
            web_dir: None,
            advertise: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct FfmpegConfig {
    /// Defaults to jellyfin-ffmpeg if installed, else `ffmpeg` on `$PATH`.
    pub ffmpeg_path: Option<PathBuf>,
    pub ffprobe_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryConfig {
    pub name: String,
    pub kind: LibraryKind,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArrConfig {
    pub url: String,
    pub api_key: String,
    pub quality_profile_id: i64,
    pub root_folder: String,
}

impl Config {
    /// `$PANDA_CONFIG`, else `./panda.toml`, else `panda.toml` in the data folder.
    pub fn load() -> anyhow::Result<Self> {
        let (data, _) = default_dirs();
        let path = std::env::var_os("PANDA_CONFIG").map_or_else(
            || {
                let local = PathBuf::from("panda.toml");
                if local.exists() { local } else { data.join("panda.toml") }
            },
            PathBuf::from,
        );
        let mut config = if path.exists() {
            Self::from_file(&path)?
        } else {
            tracing::warn!(path = %path.display(), "no config file, using defaults");
            Self::default()
        };
        config.apply_env();
        config.resolve_dirs();
        Ok(config)
    }

    /// Fill in the folders not set in the file (see `ServerConfig::data_dir`).
    fn resolve_dirs(&mut self) {
        let (data, cache) = default_dirs();
        if self.server.data_dir.as_os_str().is_empty() {
            self.server.data_dir = data;
            self.server.cache_dir.get_or_insert(cache);
        } else if let Some(c) = std::env::var_os("PANDA_CACHE_DIR") {
            self.server.cache_dir.get_or_insert(PathBuf::from(c));
        }
    }

    /// Artwork, subtitles, scrub previews: everything that can be rebuilt.
    pub fn cache_dir(&self) -> PathBuf {
        self.server.cache_dir.clone().unwrap_or_else(|| self.server.data_dir.clone())
    }

    /// Secrets can come from the environment instead of the file.
    fn apply_env(&mut self) {
        if let Ok(token) = std::env::var("PANDA_TMDB_TOKEN")
            && !token.trim().is_empty()
        {
            self.tmdb.read_access_token = Some(token.trim().to_string());
        }
        // For services and containers that pick the address outside panda.toml.
        if let Some(bind) = std::env::var("PANDA_BIND").ok().filter(|b| !b.trim().is_empty()) {
            if let Ok(addr) = bind.trim().parse() {
                self.server.bind = addr;
            } else {
                tracing::warn!(%bind, "ignoring PANDA_BIND: expected an address like 0.0.0.0:8096");
            }
        }
    }

    pub fn from_file(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn database_url(&self) -> String {
        format!("sqlite://{}", self.server.data_dir.join("panda.db").display())
    }

    /// Encryption key for secrets at rest. Lives next to the DB but is never inside it.
    pub fn secret_key_path(&self) -> PathBuf {
        self.server.data_dir.join("secret.key")
    }

    /// Where the built admin UI lives, if anywhere.
    pub fn resolve_web_dir(&self) -> Option<PathBuf> {
        // Set explicitly: always that folder. Otherwise the copy built into the binary wins, and
        // a folder next to it (or a local build) is only for binaries built without one.
        if self.server.web_dir.is_none() && crate::routes::web_bundled() {
            return None;
        }
        let candidates = [
            self.server.web_dir.clone(),
            Some(PathBuf::from("clients/web/dist")),
            std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("web"))),
        ];
        candidates.into_iter().flatten().find(|d| d.join("index.html").is_file())
    }

    /// One-time first-run token (deleted once the admin account exists).
    pub fn setup_token_path(&self) -> PathBuf {
        self.server.data_dir.join("setup-token")
    }

    pub fn transcode_dir(&self) -> PathBuf {
        self.server.transcode_dir.clone().unwrap_or_else(|| self.cache_dir().join("transcodes"))
    }
}

/// Default data and cache folders: `$PANDA_DATA_DIR` / `$PANDA_CACHE_DIR` (Docker, Linux
/// packages' service), else where this OS keeps an app's data and caches.
pub(crate) fn default_dirs() -> (PathBuf, PathBuf) {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let (data, cache) = os_dirs();
    (env("PANDA_DATA_DIR").unwrap_or(data), env("PANDA_CACHE_DIR").unwrap_or(cache))
}

#[cfg(target_os = "macos")]
fn os_dirs() -> (PathBuf, PathBuf) {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    (home.join("Library/Application Support/Panda"), home.join("Library/Caches/Panda"))
}

#[cfg(windows)]
fn os_dirs() -> (PathBuf, PathBuf) {
    // Shared by every user (Panda runs as a service).
    let base =
        std::env::var_os("ProgramData").map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
    (base.join("Panda"), base.join("Panda").join("cache"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_dirs() -> (PathBuf, PathBuf) {
    // XDG for a user run; the packaged service sets PANDA_DATA_DIR=/var/lib/panda and
    // PANDA_CACHE_DIR=/var/cache/panda.
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    let xdg =
        |k: &str, fallback: &str| std::env::var_os(k).map_or_else(|| home.join(fallback), PathBuf::from);
    (xdg("XDG_DATA_HOME", ".local/share").join("panda"), xdg("XDG_CACHE_HOME", ".cache").join("panda"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/panda.example.toml");
        let c = Config::from_file(&path).unwrap();
        assert_eq!(c.libraries.len(), 2);
        assert!(c.radarr.is_some() && c.sonarr.is_some());
        assert_eq!(c.tmdb.read_access_token.as_deref(), Some(""));
    }
}
