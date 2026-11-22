//! Payloads Sonarr/Radarr POST to a "Webhook" connection.
//! Configure it in Settings -> Connect with the On Import / On Upgrade triggers.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    /// `Test`, `Grab`, `Download` (import), `Rename`, `MovieDelete`, `SeriesDelete`, ...
    pub event_type: String,
    pub movie: Option<MovieRef>,
    pub movie_file: Option<FileRef>,
    pub series: Option<SeriesRef>,
    pub episode_file: Option<FileRef>,
}

impl Payload {
    /// True when new media landed on disk and Panda should rescan.
    pub fn is_import(&self) -> bool {
        matches!(self.event_type.as_str(), "Download" | "Rename")
    }

    /// Folder that changed, if the payload says.
    pub fn changed_folder(&self) -> Option<&str> {
        self.movie
            .as_ref()
            .and_then(|m| m.folder_path.as_deref())
            .or_else(|| self.series.as_ref().and_then(|s| s.path.as_deref()))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieRef {
    pub title: Option<String>,
    pub tmdb_id: Option<i64>,
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesRef {
    pub title: Option<String>,
    pub tvdb_id: Option<i64>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub relative_path: Option<String>,
    pub path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_radarr_import() {
        let p: Payload = serde_json::from_str(
            r#"{"eventType":"Download","movie":{"id":1,"title":"Heat","year":1995,"tmdbId":949,
               "folderPath":"/movies/Heat (1995)"},"movieFile":{"relativePath":"Heat (1995).mkv",
               "path":"/movies/Heat (1995)/Heat (1995).mkv"},"isUpgrade":false}"#,
        )
        .unwrap();
        assert!(p.is_import());
        assert_eq!(p.changed_folder(), Some("/movies/Heat (1995)"));
        assert_eq!(p.movie.unwrap().tmdb_id, Some(949));
    }

    #[test]
    fn parses_sonarr_test_event() {
        let p: Payload = serde_json::from_str(
            r#"{"eventType":"Test","series":{"title":"Test","tvdbId":1,"path":"/tv/Test"}}"#,
        )
        .unwrap();
        assert!(!p.is_import());
    }
}
