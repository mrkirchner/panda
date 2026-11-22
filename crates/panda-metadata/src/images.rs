//! On-disk artwork cache.
//!
//! TMDB image paths are content-addressed (`/abc123.jpg` never changes), so a file that exists
//! locally is always current: images are downloaded exactly once and never revalidated.

use std::path::{Path, PathBuf};

use crate::Result;
use crate::tmdb::Tmdb;

const IMAGE_BASE: &str = "https://image.tmdb.org/t/p/";

/// Only the sizes the UI draws. Originals (often 4K+) are never fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageSize {
    /// 342px wide: poster tiles (drawn at 240px, so this covers 1.4x scaling).
    Poster,
    /// 1280px wide: home/details backdrop.
    Backdrop,
    /// 300px wide: episode thumbnails.
    Still,
    /// 185px wide: cast and crew headshots (drawn as 150px circles).
    Profile,
    /// 500px wide: a title's logo (its name as artwork, transparent), on Home's feature cards.
    Logo,
}

impl ImageSize {
    /// The widest it's drawn (faces are sized by height: no limit here).
    fn max_width(self) -> Option<u32> {
        match self {
            ImageSize::Poster => Some(342),
            ImageSize::Backdrop => Some(1280),
            ImageSize::Still => Some(300),
            ImageSize::Logo => Some(500),
            ImageSize::Profile => None,
        }
    }

    fn tmdb(self) -> &'static str {
        match self {
            ImageSize::Poster => "w342",
            ImageSize::Backdrop => "w1280",
            ImageSize::Still => "w300",
            // Faces are drawn up to 260 px on the 1080p grid (the person page), and twice that on a
            // 4K Apple TV: w185 was blurry, h632 (~420 px wide) stays sharp.
            ImageSize::Profile => "h632",
            ImageSize::Logo => "w500",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImageCache {
    dir: PathBuf,
    /// For artwork URLs from Radarr/Sonarr (TMDB downloads go through the TMDB client).
    http: reqwest::Client,
    /// ffmpeg with libwebp: artwork is stored (and served) as WebP instead of TMDB's JPEG.
    webp: Option<PathBuf>,
}

impl ImageSize {
    /// WebP quality. Posters are the main visual (often with title text); backdrops are always
    /// drawn dimmed behind the UI. Measured on a real library: posters 46 -> 29 KB (-37%),
    /// backdrops 170 -> 74 KB (-56%), visually identical at 100% crops.
    fn webp_quality(self) -> u8 {
        match self {
            // Faces are looked at closely (the person page), like posters.
            ImageSize::Poster | ImageSize::Profile => 80,
            ImageSize::Backdrop => 70,
            // Thumbnails.
            ImageSize::Still => 75,
            // Lettering: soft edges show.
            ImageSize::Logo => 85,
        }
    }

    fn from_key(key: &str) -> Option<Self> {
        match key.split('_').next()? {
            "w342" => Some(ImageSize::Poster),
            "w1280" => Some(ImageSize::Backdrop),
            "w300" => Some(ImageSize::Still),
            // w185: headshots cached before they moved to h632.
            "h632" | "w185" => Some(ImageSize::Profile),
            "w500" => Some(ImageSize::Logo),
            _ => None,
        }
    }
}

/// Cache key and download URL for an artwork URL from Radarr/Sonarr, or `None` for other hosts.
/// TMDB URLs (any size) become the regular TMDB key at `size`; `TheTVDB` ones keep their file name.
/// A number for temp file names, unique within this process.
fn next_part() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn remote_key(size: ImageSize, url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.strip_prefix(IMAGE_BASE) {
        // `original/abc.jpg` or `w500/abc.jpg`: keep the file, use our size.
        let path = rest.split_once('/')?.1;
        let key = ImageCache::key(size, path)?;
        return Some((key, format!("{IMAGE_BASE}{}/{path}", size.tmdb())));
    }
    for (host, tag) in [
        ("https://artworks.thetvdb.com/", "tvdb"),
        ("https://thetvdb.com/", "tvdb"),
        ("https://assets.fanart.tv/", "fanart"),
    ] {
        if url.starts_with(host) {
            let name = url.rsplit('/').next()?.split('?').next()?;
            let is_image =
                [".jpg", ".jpeg", ".png", ".webp"].iter().any(|e| name.to_ascii_lowercase().ends_with(e));
            if !is_image || name.starts_with('.') {
                return None;
            }
            let key = format!("{}_{tag}_{name}", size.tmdb());
            return valid_name(&key).then(|| (key, url.to_string()));
        }
    }
    None
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

impl ImageCache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("static client config");
        Self { dir: dir.into(), http, webp: None }
    }

    /// Store artwork as WebP, encoded once at download time with this ffmpeg (needs libwebp).
    #[must_use]
    pub fn with_webp(mut self, ffmpeg: impl Into<PathBuf>) -> Self {
        self.webp = Some(ffmpeg.into());
        self
    }

    pub fn webp_enabled(&self) -> bool {
        self.webp.is_some()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Original TMDB key (`w342_abc123.jpg`). Safe as a file name and a URL segment.
    pub fn key(size: ImageSize, tmdb_path: &str) -> Option<String> {
        let name = tmdb_path.trim_start_matches('/');
        valid_name(name).then(|| format!("{}_{name}", size.tmdb()))
    }

    /// The key this cache stores: the WebP name when WebP is enabled.
    pub fn cache_key(&self, size: ImageSize, tmdb_path: &str) -> Option<String> {
        let key = Self::key(size, tmdb_path)?;
        Some(if self.webp.is_some() { webp_name(&key) } else { key })
    }

    /// Path on disk for a key produced by this cache. Rejects anything else.
    pub fn path_for_key(&self, key: &str) -> Option<PathBuf> {
        valid_name(key).then(|| self.dir.join(key))
    }

    /// Ensure the image is on disk and return its key. Downloads (and converts) only if missing.
    pub async fn fetch(&self, tmdb: &Tmdb, size: ImageSize, tmdb_path: &str) -> Result<Option<String>> {
        let Some(key) = self.cache_key(size, tmdb_path) else { return Ok(None) };
        if tokio::fs::try_exists(self.dir.join(&key)).await? {
            return Ok(Some(key));
        }
        let bytes = tmdb.bytes(&format!("{IMAGE_BASE}{}{}", size.tmdb(), ensure_slash(tmdb_path))).await?;
        let original = Self::key(size, tmdb_path).expect("validated by cache_key");
        self.store(&original, &key, size, &bytes).await.map(Some)
    }

    /// Cache an image Radarr/Sonarr or Fanart.tv point at (their lookups carry artwork URLs).
    /// Only TMDB's, `TheTVDB`'s and Fanart.tv's image hosts are fetched; TMDB URLs map to the
    /// same keys (and the smaller size) as library artwork; others are scaled down to `size`.
    pub async fn fetch_remote(&self, size: ImageSize, url: &str) -> Result<Option<String>> {
        let Some((original, fetch_url)) = remote_key(size, url) else { return Ok(None) };
        // Fanart.tv sends originals (often 4K): only kept when they can be scaled down (the
        // WebP step does that; without libwebp they'd be stored and served full size).
        if self.webp.is_none() && original.contains("_fanart_") {
            return Ok(None);
        }
        let key = if self.webp.is_some() { webp_name(&original) } else { original.clone() };
        if tokio::fs::try_exists(self.dir.join(&key)).await? {
            return Ok(Some(key));
        }
        let res = self.http.get(&fetch_url).send().await?;
        let status = res.status();
        if !status.is_success() {
            return Err(crate::Error::Status { status, body: String::new() });
        }
        let bytes = crate::read_capped(res, crate::MAX_IMAGE_BYTES).await?;
        self.store(&original, &key, size, &bytes).await.map(Some)
    }

    /// Write downloaded bytes under `original` (or converted, under `key`), returning the key kept.
    async fn store(&self, original: &str, key: &str, size: ImageSize, bytes: &[u8]) -> Result<String> {
        tokio::fs::create_dir_all(&self.dir).await?;
        // Write then rename so a crash never leaves a truncated image that looks cached.
        // Unique per download: two requests for the same picture never write one temp file.
        let tmp = self.dir.join(format!(".{original}.{}.part", next_part()));
        tokio::fs::write(&tmp, bytes).await?;
        if self.webp.is_some() {
            match self.convert(&tmp, key, size).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Ok(key.to_string());
                }
                Err(e) => tracing::warn!(key, error = %e, "WebP conversion failed; keeping JPEG"),
            }
        }
        tokio::fs::rename(&tmp, self.dir.join(original)).await?;
        Ok(original.to_string())
    }

    /// Convert an already-cached JPEG key to WebP (one-time migration). Returns the new key
    /// and removes the JPEG; `None` if WebP is disabled or the file isn't a JPEG key.
    pub async fn migrate_to_webp(&self, jpeg_key: &str) -> Result<Option<String>> {
        let Some(size) = ImageSize::from_key(jpeg_key) else { return Ok(None) };
        let is_jpeg = Path::new(jpeg_key).extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg"));
        if self.webp.is_none() || !is_jpeg || !valid_name(jpeg_key) {
            return Ok(None);
        }
        let src = self.dir.join(jpeg_key);
        let key = webp_name(jpeg_key);
        if !tokio::fs::try_exists(self.dir.join(&key)).await? {
            if !tokio::fs::try_exists(&src).await? {
                return Ok(None);
            }
            self.convert(&src, &key, size).await?;
        }
        let _ = tokio::fs::remove_file(&src).await;
        Ok(Some(key))
    }

    /// JPEG file -> `key` (WebP), atomically.
    async fn convert(&self, src: &Path, key: &str, size: ImageSize) -> Result<()> {
        let ffmpeg = self.webp.as_ref().expect("webp enabled");
        let part = self.dir.join(format!(".{key}.{}.part", next_part()));
        let out = tokio::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(src)
            .args([
                "-c:v",
                "libwebp",
                "-quality",
                &size.webp_quality().to_string(),
                // Level 6 (the slowest) took 4 s for a transparent logo against 0.1 s at 4, for
                // a file 1-5% smaller.
                "-compression_level",
                "4",
            ])
            // Only as large as it's drawn: TMDB sends that size already, other hosts originals.
            .args(
                size.max_width()
                    .map(|w| vec!["-vf".to_string(), format!("scale='min({w},iw)':-2")])
                    .unwrap_or_default(),
            )
            // Logos are lettering on transparency: keep the alpha channel.
            .args(if size == ImageSize::Logo { &["-pix_fmt", "yuva420p"][..] } else { &[][..] })
            .args(["-f", "webp"])
            .arg(&part)
            .kill_on_drop(true)
            .output()
            .await?;
        if !out.status.success() {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(std::io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string()).into());
        }
        tokio::fs::rename(&part, self.dir.join(key)).await?;
        Ok(())
    }
}

/// `w342_abc123.jpg` -> `w342_abc123.webp`.
fn webp_name(key: &str) -> String {
    let stem = key.rsplit_once('.').map_or(key, |(s, _)| s);
    format!("{stem}.webp")
}

fn ensure_slash(p: &str) -> String {
    if p.starts_with('/') { p.to_string() } else { format!("/{p}") }
}

#[cfg(test)]
mod tests {

    #[test]
    fn remote_artwork_keys_only_for_known_hosts() {
        let (k, u) = remote_key(ImageSize::Poster, "https://image.tmdb.org/t/p/original/abc.jpg").unwrap();
        assert_eq!(k, "w342_abc.jpg", "same key as library artwork");
        assert_eq!(u, "https://image.tmdb.org/t/p/w342/abc.jpg", "fetched at our size");
        let (k, _) =
            remote_key(ImageSize::Poster, "https://artworks.thetvdb.com/banners/posters/81189-1.jpg")
                .unwrap();
        assert_eq!(k, "w342_tvdb_81189-1.jpg");
        assert!(remote_key(ImageSize::Poster, "https://evil.example/x.jpg").is_none());
        assert!(remote_key(ImageSize::Poster, "http://169.254.169.254/latest").is_none());
        assert!(remote_key(ImageSize::Poster, "https://artworks.thetvdb.com/a/..").is_none());
    }

    use super::*;

    #[test]
    fn webp_keys() {
        let jpeg = ImageCache::new("/data/images");
        let webp = ImageCache::new("/data/images").with_webp("/usr/bin/ffmpeg");
        assert_eq!(jpeg.cache_key(ImageSize::Poster, "/abc.jpg").as_deref(), Some("w342_abc.jpg"));
        assert_eq!(webp.cache_key(ImageSize::Poster, "/abc.jpg").as_deref(), Some("w342_abc.webp"));
        assert_eq!(webp.cache_key(ImageSize::Backdrop, "/x.png").as_deref(), Some("w1280_x.webp"));
    }

    #[tokio::test]
    async fn converts_jpeg_to_smaller_webp() {
        let Ok(ffmpeg) = which_ffmpeg() else { return };
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("w1280_test.jpg");
        let made = std::process::Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1280x720",
                "-frames:v",
                "1",
                "-q:v",
                "2",
            ])
            .arg(&jpg)
            .status()
            .unwrap();
        assert!(made.success());
        let cache = ImageCache::new(dir.path()).with_webp(&ffmpeg);
        let has_webp =
            std::process::Command::new(&ffmpeg).args(["-hide_banner", "-encoders"]).output().unwrap();
        if !String::from_utf8_lossy(&has_webp.stdout).contains("libwebp") {
            return;
        }
        let key = cache.migrate_to_webp("w1280_test.jpg").await.unwrap().unwrap();
        assert_eq!(key, "w1280_test.webp");
        let webp = std::fs::read(dir.path().join(&key)).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        assert!(!jpg.exists(), "the JPEG is replaced, not kept alongside");
    }

    fn which_ffmpeg() -> std::result::Result<PathBuf, ()> {
        let jf = std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/jellyfin-ffmpeg/ffmpeg"));
        if let Some(p) = jf.filter(|p| p.is_file()) {
            return Ok(p);
        }
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|_| PathBuf::from("ffmpeg"))
            .map_err(|_| ())
    }

    #[test]
    fn fanart_urls_get_their_own_keys_and_other_hosts_none() {
        let (key, url) =
            remote_key(ImageSize::Logo, "https://assets.fanart.tv/fanart/movies/603/hdmovielogo/x-1.png")
                .unwrap();
        assert_eq!(key, "w500_fanart_x-1.png");
        assert_eq!(url, "https://assets.fanart.tv/fanart/movies/603/hdmovielogo/x-1.png");
        assert!(remote_key(ImageSize::Poster, "https://evil.example/fanart/x.jpg").is_none());
        assert!(
            remote_key(ImageSize::Poster, "https://assets.fanart.tv/fanart/x.svg").is_none(),
            "images only"
        );
    }

    #[test]
    fn keys_are_flat_and_safe() {
        assert_eq!(ImageCache::key(ImageSize::Poster, "/ve72Vx.jpg").as_deref(), Some("w342_ve72Vx.jpg"));
        assert_eq!(ImageCache::key(ImageSize::Poster, "/../etc/passwd"), None);
        let cache = ImageCache::new("/data/images");
        assert!(cache.path_for_key("w342_a.jpg").is_some());
        assert!(cache.path_for_key("../panda.db").is_none());
        assert!(cache.path_for_key(".w342_a.jpg.part").is_none());
    }
}
