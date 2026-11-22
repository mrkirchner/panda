use serde::{Deserialize, Serialize};

use crate::progress::QueueItem;
use crate::{AddDefaults, ArrClient, Image, QualityProfile, Result, RootFolder, SystemStatus};

#[derive(Debug, Clone)]
pub struct Radarr {
    client: ArrClient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Movie {
    /// Radarr's own id. `None` for lookup results that aren't in Radarr yet.
    pub id: Option<i64>,
    pub title: String,
    pub year: Option<i32>,
    pub tmdb_id: i64,
    pub overview: Option<String>,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub has_file: bool,
    #[serde(default)]
    pub monitored: bool,
    /// When Radarr added it (absent on lookup results).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<chrono::DateTime<chrono::Utc>>,
    /// The file on disk, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub movie_file: Option<MovieFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieFile {
    pub date_added: Option<chrono::DateTime<chrono::Utc>>,
    /// Radarr is still looking for a better release (the profile's cutoff isn't met).
    #[serde(default)]
    pub quality_cutoff_not_met: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddMovie<'a> {
    title: &'a str,
    year: Option<i32>,
    tmdb_id: i64,
    quality_profile_id: i64,
    root_folder_path: &'a str,
    monitored: bool,
    minimum_availability: &'static str,
    add_options: AddMovieOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddMovieOptions {
    search_for_movie: bool,
}

impl Radarr {
    pub fn new(base_url: &str, api_key: impl Into<String>) -> Result<Self> {
        Ok(Self { client: ArrClient::new("radarr", base_url, api_key)? })
    }

    pub async fn status(&self) -> Result<SystemStatus> {
        self.client.get("api/v3/system/status", &[]).await
    }

    pub async fn lookup(&self, term: &str) -> Result<Vec<Movie>> {
        self.client.get("api/v3/movie/lookup", &[("term", term)]).await
    }

    /// Every movie Radarr has (monitored or not), with whether its file is on disk.
    pub async fn movies(&self) -> Result<Vec<Movie>> {
        self.client.get("api/v3/movie", &[]).await
    }

    /// The movie as Radarr has it (by TMDB id), if it's been added.
    pub async fn movie_by_tmdb(&self, tmdb_id: i64) -> Result<Option<Movie>> {
        let id = tmdb_id.to_string();
        let movies: Vec<Movie> = self.client.get("api/v3/movie", &[("tmdbId", id.as_str())]).await?;
        Ok(movies.into_iter().next())
    }

    /// Take a movie off Radarr's list, keeping its files (and not blocking it from being
    /// added again later).
    pub async fn remove_movie(&self, movie_id: i64) -> Result<()> {
        self.client
            .delete(
                &format!("api/v3/movie/{movie_id}"),
                &[("deleteFiles", "false"), ("addImportExclusion", "false")],
            )
            .await
    }

    /// This movie's downloads in progress.
    pub async fn queue_for_movie(&self, movie_id: i64) -> Result<Vec<QueueItem>> {
        let id = movie_id.to_string();
        self.client.get("api/v3/queue/details", &[("movieId", id.as_str())]).await
    }

    pub async fn quality_profiles(&self) -> Result<Vec<QualityProfile>> {
        self.client.get("api/v3/qualityprofile", &[]).await
    }

    pub async fn root_folders(&self) -> Result<Vec<RootFolder>> {
        self.client.get("api/v3/rootfolder", &[]).await
    }

    /// Add a movie and immediately search indexers for it.
    pub async fn add(&self, movie: &Movie, defaults: &AddDefaults) -> Result<Movie> {
        self.client.post("api/v3/movie", &add_body(movie, defaults)).await
    }
}

fn add_body<'a>(movie: &'a Movie, defaults: &'a AddDefaults) -> AddMovie<'a> {
    AddMovie {
        title: &movie.title,
        year: movie.year,
        tmdb_id: movie.tmdb_id,
        quality_profile_id: defaults.quality_profile_id,
        root_folder_path: &defaults.root_folder,
        monitored: true,
        minimum_availability: "released",
        add_options: AddMovieOptions { search_for_movie: true },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_body_matches_radarr_schema() {
        let m: Movie = serde_json::from_str(
            r#"{"title":"Heat","year":1995,"tmdbId":949,"images":[],"overview":"x","ratings":{}}"#,
        )
        .unwrap();
        let d = AddDefaults { quality_profile_id: 4, root_folder: "/movies".into() };
        assert_eq!(
            serde_json::to_value(add_body(&m, &d)).unwrap(),
            serde_json::json!({
                "title": "Heat", "year": 1995, "tmdbId": 949, "qualityProfileId": 4,
                "rootFolderPath": "/movies", "monitored": true, "minimumAvailability": "released",
                "addOptions": {"searchForMovie": true}
            })
        );
    }
}
