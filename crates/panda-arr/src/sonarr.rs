use serde::{Deserialize, Serialize};

use crate::progress::QueueItem;
use crate::{AddDefaults, ArrClient, Image, QualityProfile, Result, RootFolder, SystemStatus};

#[derive(Debug, Clone)]
pub struct Sonarr {
    client: ArrClient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    /// Sonarr's own id. `None` for lookup results that aren't in Sonarr yet.
    pub id: Option<i64>,
    pub title: String,
    pub year: Option<i32>,
    pub tvdb_id: i64,
    pub tmdb_id: Option<i64>,
    pub overview: Option<String>,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub monitored: bool,
    /// Present on series Sonarr has (not on lookup results).
    #[serde(default)]
    pub statistics: Option<SeriesStatistics>,
    #[serde(default)]
    pub seasons: Vec<SeasonInfo>,
    /// No more episodes are coming (Sonarr's `ended`, or status "ended").
    #[serde(default)]
    pub ended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// When Sonarr added it (absent on lookup results).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<chrono::DateTime<chrono::Utc>>,
}

impl Series {
    pub fn has_ended(&self) -> bool {
        self.ended || self.status.as_deref() == Some("ended")
    }
}

/// A downloaded episode file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeFile {
    pub date_added: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub quality_cutoff_not_met: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonInfo {
    pub season_number: i64,
    #[serde(default)]
    pub monitored: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStatistics {
    #[serde(default)]
    pub episode_file_count: i64,
    #[serde(default)]
    pub episode_count: i64,
}

impl SeriesStatistics {
    /// Share of monitored episodes on disk (0-1).
    pub fn on_disk(&self) -> f64 {
        if self.episode_count > 0 {
            (self.episode_file_count as f64 / self.episode_count as f64).clamp(0.0, 1.0)
        } else if self.episode_file_count > 0 {
            1.0
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddSeries<'a> {
    title: &'a str,
    tvdb_id: i64,
    quality_profile_id: i64,
    root_folder_path: &'a str,
    monitored: bool,
    season_folder: bool,
    /// Which seasons to monitor (only when choosing seasons; otherwise Sonarr's default).
    #[serde(skip_serializing_if = "Option::is_none")]
    seasons: Option<Vec<SeasonInfo>>,
    add_options: AddSeriesOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddSeriesOptions {
    monitor: &'static str,
    search_for_missing_episodes: bool,
}

impl Sonarr {
    pub fn new(base_url: &str, api_key: impl Into<String>) -> Result<Self> {
        Ok(Self { client: ArrClient::new("sonarr", base_url, api_key)? })
    }

    pub async fn status(&self) -> Result<SystemStatus> {
        self.client.get("api/v3/system/status", &[]).await
    }

    pub async fn lookup(&self, term: &str) -> Result<Vec<Series>> {
        self.client.get("api/v3/series/lookup", &[("term", term)]).await
    }

    /// Every series Sonarr has, with episode statistics.
    pub async fn all_series(&self) -> Result<Vec<Series>> {
        self.client.get("api/v3/series", &[]).await
    }

    /// The series as Sonarr has it (by TVDB id), if it's been added.
    pub async fn series_by_tvdb(&self, tvdb_id: i64) -> Result<Option<Series>> {
        let id = tvdb_id.to_string();
        let series: Vec<Series> = self.client.get("api/v3/series", &[("tvdbId", id.as_str())]).await?;
        Ok(series.into_iter().next())
    }

    /// The series' downloaded episode files.
    pub async fn episode_files(&self, series_id: i64) -> Result<Vec<EpisodeFile>> {
        let id = series_id.to_string();
        self.client.get("api/v3/episodefile", &[("seriesId", id.as_str())]).await
    }

    /// Take a series off Sonarr's list, keeping its files.
    pub async fn remove_series(&self, series_id: i64) -> Result<()> {
        self.client
            .delete(
                &format!("api/v3/series/{series_id}"),
                &[("deleteFiles", "false"), ("addImportListExclusion", "false")],
            )
            .await
    }

    /// This series' downloads in progress.
    pub async fn queue_for_series(&self, series_id: i64) -> Result<Vec<QueueItem>> {
        let id = series_id.to_string();
        self.client.get("api/v3/queue/details", &[("seriesId", id.as_str())]).await
    }

    pub async fn quality_profiles(&self) -> Result<Vec<QualityProfile>> {
        self.client.get("api/v3/qualityprofile", &[]).await
    }

    pub async fn root_folders(&self) -> Result<Vec<RootFolder>> {
        self.client.get("api/v3/rootfolder", &[]).await
    }

    /// Add a series, monitor all episodes and search for missing ones.
    pub async fn add(&self, series: &Series, defaults: &AddDefaults) -> Result<Series> {
        let body = AddSeries {
            title: &series.title,
            tvdb_id: series.tvdb_id,
            quality_profile_id: defaults.quality_profile_id,
            root_folder_path: &defaults.root_folder,
            monitored: true,
            season_folder: true,
            seasons: None,
            add_options: AddSeriesOptions { monitor: "all", search_for_missing_episodes: true },
        };
        self.client.post("api/v3/series", &body).await
    }

    /// Get only some seasons: add the series (if it isn't in Sonarr yet) with nothing else
    /// monitored, monitor these seasons (keeping any it already watches) and search for them.
    pub async fn add_seasons(&self, series: &Series, defaults: &AddDefaults, wanted: &[i64]) -> Result<()> {
        let id = if let Some(id) = series.id {
            id
        } else {
            let body = AddSeries {
                title: &series.title,
                tvdb_id: series.tvdb_id,
                quality_profile_id: defaults.quality_profile_id,
                root_folder_path: &defaults.root_folder,
                monitored: true,
                season_folder: true,
                seasons: Some(
                    series
                        .seasons
                        .iter()
                        .map(|s| SeasonInfo {
                            season_number: s.season_number,
                            monitored: wanted.contains(&s.season_number),
                        })
                        .collect(),
                ),
                add_options: AddSeriesOptions { monitor: "none", search_for_missing_episodes: false },
            };
            let added: Series = self.client.post("api/v3/series", &body).await?;
            added.id.ok_or(crate::Error::Missing("series id"))?
        };
        // Monitor the chosen seasons on the series as Sonarr has it (the full record goes back,
        // so nothing else changes); Sonarr marks their episodes monitored too.
        let path = format!("api/v3/series/{id}");
        let mut record: serde_json::Value = self.client.get(&path, &[]).await?;
        record["monitored"] = serde_json::Value::Bool(true);
        if let Some(seasons) = record["seasons"].as_array_mut() {
            for s in seasons {
                if s["seasonNumber"].as_i64().is_some_and(|n| wanted.contains(&n)) {
                    s["monitored"] = serde_json::Value::Bool(true);
                }
            }
        }
        let _: serde_json::Value = self.client.put(&path, &record).await?;
        for season in wanted {
            let cmd = serde_json::json!({ "name": "SeasonSearch", "seriesId": id, "seasonNumber": season });
            let _: serde_json::Value = self.client.post("api/v3/command", &cmd).await?;
        }
        Ok(())
    }
}
