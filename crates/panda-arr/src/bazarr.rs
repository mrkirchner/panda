//! Bazarr (subtitles for Sonarr's and Radarr's files): just what Panda asks of it, finding a
//! movie or episode by its file and asking for subtitles in a language.

use serde::Deserialize;

use crate::{ArrClient, Result};

#[derive(Debug, Clone)]
pub struct Bazarr {
    client: ArrClient,
}

/// Bazarr wraps its lists: `{"data": [...]}`.
#[derive(Debug, Deserialize)]
struct Page<T> {
    data: Vec<T>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Status {
    pub bazarr_version: String,
}

#[derive(Debug, Deserialize)]
struct StatusPage {
    data: Status,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Movie {
    pub radarr_id: i64,
    /// The file, as Bazarr sees it (its own mount of the share).
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub sonarr_series_id: i64,
    /// The show's folder, as Bazarr sees it.
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub sonarr_series_id: i64,
    pub sonarr_episode_id: i64,
    pub path: String,
}

impl Bazarr {
    pub fn new(base_url: &str, api_key: impl Into<String>) -> Result<Self> {
        Ok(Self { client: ArrClient::new("bazarr", base_url, api_key)? })
    }

    pub async fn status(&self) -> Result<Status> {
        Ok(self.client.get::<StatusPage>("api/system/status", &[]).await?.data)
    }

    /// Every movie Bazarr knows (from its Radarr).
    pub async fn movies(&self) -> Result<Vec<Movie>> {
        Ok(self.client.get::<Page<Movie>>("api/movies", &[("start", "0"), ("length", "-1")]).await?.data)
    }

    /// Every show Bazarr knows (from its Sonarr).
    pub async fn series(&self) -> Result<Vec<Series>> {
        Ok(self.client.get::<Page<Series>>("api/series", &[("start", "0"), ("length", "-1")]).await?.data)
    }

    pub async fn episodes(&self, series_id: i64) -> Result<Vec<Episode>> {
        let id = series_id.to_string();
        Ok(self.client.get::<Page<Episode>>("api/episodes", &[("seriesid[]", &id)]).await?.data)
    }

    /// Search the providers for `language` (ISO 639-1) subtitles for a movie and save the best.
    pub async fn download_movie(&self, radarr_id: i64, language: &str) -> Result<()> {
        let id = radarr_id.to_string();
        self.client
            .patch_query(
                "api/movies/subtitles",
                &[("radarrid", &id), ("language", language), ("forced", "False"), ("hi", "False")],
            )
            .await
    }

    /// The same for an episode.
    pub async fn download_episode(&self, series_id: i64, episode_id: i64, language: &str) -> Result<()> {
        let (s, e) = (series_id.to_string(), episode_id.to_string());
        self.client
            .patch_query(
                "api/episodes/subtitles",
                &[
                    ("seriesid", &s),
                    ("episodeid", &e),
                    ("language", language),
                    ("forced", "False"),
                    ("hi", "False"),
                ],
            )
            .await
    }
}

/// The last `n` parts of a path, compared across mounts (Bazarr's `/mnt/media/Movies/X/X.mkv` is
/// Panda's `/Volumes/Media/Movies/X/X.mkv`): file name and its folders, NFC, case kept.
#[must_use]
pub fn tail(path: &str, n: usize) -> String {
    use unicode_normalization::UnicodeNormalization;
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(n)..].join("/").nfc().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tails_match_across_mounts() {
        let bazarr = "/mnt/media/Movies-4K/Heat (1995)/Heat (1995) Bluray-2160p.mkv";
        let panda = "/Volumes/Media-1/Movies-4K/Heat (1995)/Heat (1995) Bluray-2160p.mkv";
        assert_eq!(tail(bazarr, 2), tail(panda, 2));
        assert_eq!(tail("/mnt/media/Shows-HD/Alien - Earth", 1), "Alien - Earth");
        // macOS/SMB NFD vs Linux NFC.
        assert_eq!(tail("/a/Ame\u{301}lie.mkv", 1), tail("/b/Am\u{e9}lie.mkv", 1));
    }
}
