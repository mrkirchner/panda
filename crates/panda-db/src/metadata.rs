use std::collections::HashMap;

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::{Db, Result};

/// Unmatched files are retried after this long (TMDB gains new titles constantly).
const RETRY_UNMATCHED_AFTER_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, sqlx::Type)]
#[sqlx(rename_all = "snake_case")]
pub enum MetadataKind {
    Movie,
    Series,
}

#[derive(Debug, Clone)]
pub struct NewMetadata {
    pub kind: MetadataKind,
    pub tmdb_id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub genres: Option<String>,
    pub runtime_mins: Option<i64>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewEpisode {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub still: Option<String>,
}

/// A movie file still waiting for a TMDB match.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingMovie {
    pub id: i64,
    pub title: String,
    pub year: Option<i64>,
}

/// An episode file whose series still needs a TMDB match.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingEpisode {
    pub id: i64,
    pub series: String,
    pub season: i64,
    /// `None` for title-only files; `title` then holds the name to match against TMDB.
    pub episode: Option<i64>,
    pub title: String,
}

/// A season of a show folder taken from another TMDB show (an anthology's story).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SeasonMatch {
    /// The folder's normalized name.
    pub folder: String,
    pub season: i64,
    pub tmdb_id: i64,
    pub tmdb_season: i64,
    pub title: String,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub overview: Option<String>,
    pub year: Option<i64>,
}

impl Db {
    /// Remember a hand-fixed match for this (normalized) name.
    pub async fn set_match_override(
        &self,
        kind: MetadataKind,
        name: &str,
        tmdb_id: i64,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO match_overrides (kind, name, tmdb_id, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (kind, name) DO UPDATE SET tmdb_id = excluded.tmdb_id, created_at = excluded.created_at",
        )
        .bind(kind)
        .bind(name)
        .bind(tmdb_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The hand-fixed match for this (normalized) name, if any.
    /// Map season `m.season` of a show folder (normalized name) to a season of another TMDB show.
    pub async fn set_season_match(&self, m: &SeasonMatch, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO season_matches (folder, season, tmdb_id, tmdb_season, title, poster, backdrop,
                                         overview, year, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (folder, season) DO UPDATE SET
                tmdb_id = excluded.tmdb_id, tmdb_season = excluded.tmdb_season, title = excluded.title,
                poster = excluded.poster, backdrop = excluded.backdrop, overview = excluded.overview,
                year = excluded.year, created_at = excluded.created_at",
        )
        .bind(&m.folder)
        .bind(m.season)
        .bind(m.tmdb_id)
        .bind(m.tmdb_season)
        .bind(&m.title)
        .bind(&m.poster)
        .bind(&m.backdrop)
        .bind(&m.overview)
        .bind(m.year)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A show folder's (normalized name) seasons matched by hand, by season.
    pub async fn season_matches(&self, folder: &str) -> Result<Vec<SeasonMatch>> {
        Ok(sqlx::query_as(
            "SELECT folder, season, tmdb_id, tmdb_season, title, poster, backdrop, overview, year
             FROM season_matches WHERE folder = ? ORDER BY season",
        )
        .bind(folder)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Back to the show's own season. True if there was a match.
    pub async fn delete_season_match(&self, folder: &str, season: i64) -> Result<bool> {
        Ok(sqlx::query("DELETE FROM season_matches WHERE folder = ? AND season = ?")
            .bind(folder)
            .bind(season)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }

    /// The stored show a folder (any case) is matched to: (metadata id, TMDB id).
    pub async fn folder_show(&self, folder: &str) -> Result<Option<(i64, i64)>> {
        Ok(sqlx::query_as(
            "SELECT m.id, m.tmdb_id FROM items i JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'episode' AND LOWER(i.series) = LOWER(?) AND m.tmdb_id IS NOT NULL LIMIT 1",
        )
        .bind(folder)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Forget a season's episodes: the shown rows and every provider's answers about them
    /// (its episodes now come from somewhere else).
    pub async fn clear_season_episodes(&self, metadata_id: i64, season: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM episode_metadata WHERE metadata_id = ? AND season = ?")
            .bind(metadata_id)
            .bind(season)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM provider_values WHERE metadata_id = ? AND season = ?")
            .bind(metadata_id)
            .bind(season)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The episode order (TMDB episode group id) a show folder (normalized name) is numbered by.
    pub async fn episode_order(&self, folder: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar("SELECT group_id FROM episode_orders WHERE folder = ?")
            .bind(folder)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn set_episode_order(&self, folder: &str, group_id: &str, name: &str, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO episode_orders (folder, group_id, name, set_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (folder) DO UPDATE SET group_id = excluded.group_id, name = excluded.name,
                set_at = excluded.set_at",
        )
        .bind(folder)
        .bind(group_id)
        .bind(name)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Back to TMDB's default seasons.
    pub async fn clear_episode_order(&self, folder: &str) -> Result<()> {
        sqlx::query("DELETE FROM episode_orders WHERE folder = ?").bind(folder).execute(&self.pool).await?;
        Ok(())
    }

    /// One field `provider` gave for each of these titles (`logo`, ...), by TMDB id.
    pub async fn title_field_values(
        &self,
        kind: MetadataKind,
        tmdb_ids: &[i64],
        provider: &str,
        field: &str,
    ) -> Result<HashMap<i64, String>> {
        if tmdb_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut q = sqlx::QueryBuilder::new(
            "SELECT m.tmdb_id, v.value FROM metadata m
             JOIN provider_values v ON v.metadata_id = m.id AND v.season = -1 AND v.episode = -1
             WHERE m.kind = ",
        );
        q.push_bind(kind).push(" AND v.provider = ").push_bind(provider);
        q.push(" AND v.field = ").push_bind(field).push(" AND m.tmdb_id IN (");
        let mut sep = q.separated(", ");
        for id in tmdb_ids {
            sep.push_bind(*id);
        }
        sep.push_unseparated(")");
        let rows: Vec<(i64, String)> = q.build_query_as().fetch_all(&self.pool).await?;
        Ok(rows.into_iter().collect())
    }

    pub async fn match_override(&self, kind: MetadataKind, name: &str) -> Result<Option<i64>> {
        Ok(sqlx::query_scalar("SELECT tmdb_id FROM match_overrides WHERE kind = ? AND name = ?")
            .bind(kind)
            .bind(name)
            .fetch_optional(&self.pool)
            .await?)
    }

    /// Stored logos (image keys; `None`: TMDB has none) of these titles, with when they were
    /// fetched, by TMDB id. `kind`: "movie" or "series".
    pub async fn title_logos(
        &self,
        kind: &str,
        tmdb_ids: &[i64],
    ) -> Result<HashMap<i64, (Option<String>, i64)>> {
        if tmdb_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut q =
            sqlx::QueryBuilder::new("SELECT tmdb_id, logo, fetched_at FROM title_logos WHERE kind = ");
        q.push_bind(kind).push(" AND tmdb_id IN (");
        let mut sep = q.separated(", ");
        for id in tmdb_ids {
            sep.push_bind(*id);
        }
        sep.push_unseparated(")");
        let rows: Vec<(i64, Option<String>, i64)> = q.build_query_as().fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id, logo, at)| (id, (logo, at))).collect())
    }

    pub async fn set_title_logo(&self, kind: &str, tmdb_id: i64, logo: Option<&str>, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO title_logos (kind, tmdb_id, logo, fetched_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (kind, tmdb_id) DO UPDATE SET logo = excluded.logo, fetched_at = excluded.fetched_at",
        )
        .bind(kind)
        .bind(tmdb_id)
        .bind(logo)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A cached details page (JSON) and when it was fetched.
    /// TMDB ids of what's in the library: (movies, shows).
    pub async fn library_tmdb_ids(&self) -> Result<(Vec<i64>, Vec<i64>)> {
        let movies: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT m.tmdb_id FROM items i JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'movie' AND m.tmdb_id IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        let shows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT m.tmdb_id FROM items i JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'episode' AND m.tmdb_id IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok((movies.into_iter().map(|r| r.0).collect(), shows.into_iter().map(|r| r.0).collect()))
    }

    pub async fn title_details(&self, kind: &str, tmdb_id: i64) -> Result<Option<(String, i64)>> {
        Ok(sqlx::query_as("SELECT details, fetched_at FROM title_details WHERE kind = ? AND tmdb_id = ?")
            .bind(kind)
            .bind(tmdb_id)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn save_title_details(&self, kind: &str, tmdb_id: i64, details: &str, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO title_details (kind, tmdb_id, details, fetched_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (kind, tmdb_id) DO UPDATE SET details = excluded.details, fetched_at = excluded.fetched_at",
        )
        .bind(kind)
        .bind(tmdb_id)
        .bind(details)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn pending_movies(&self) -> Result<Vec<PendingMovie>> {
        Ok(sqlx::query_as(
            "SELECT id, title, year FROM items
             WHERE kind = 'movie' AND metadata_id IS NULL
               AND (match_attempted_at IS NULL OR match_attempted_at < ?)",
        )
        .bind(retry_cutoff())
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn pending_episodes(&self) -> Result<Vec<PendingEpisode>> {
        Ok(sqlx::query_as(
            "SELECT id, series, season, episode, title FROM items
             WHERE kind = 'episode' AND series IS NOT NULL AND metadata_id IS NULL
               AND (match_attempted_at IS NULL OR match_attempted_at < ?)",
        )
        .bind(retry_cutoff())
        .fetch_all(&self.pool)
        .await?)
    }

    /// Insert or update a title's TMDB details. A stored title keeps its shown plot, poster and
    /// backdrop: those are picked from every provider's answers (`set_shown_overview`,
    /// `set_shown_poster`, ...), so they aren't written twice.
    pub async fn upsert_metadata(&self, m: &NewMetadata) -> Result<i64> {
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO metadata (kind, tmdb_id, title, original_title, year, overview, tagline, genres,
                                   runtime_mins, rating, poster, backdrop, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (kind, tmdb_id) DO UPDATE SET
                title = excluded.title, original_title = excluded.original_title, year = excluded.year,
                tagline = excluded.tagline, genres = excluded.genres,
                runtime_mins = excluded.runtime_mins, rating = excluded.rating,
                fetched_at = excluded.fetched_at
             RETURNING id",
        )
        .bind(m.kind)
        .bind(m.tmdb_id)
        .bind(&m.title)
        .bind(&m.original_title)
        .bind(m.year)
        .bind(&m.overview)
        .bind(&m.tagline)
        .bind(&m.genres)
        .bind(m.runtime_mins)
        .bind(m.rating)
        .bind(&m.poster)
        .bind(&m.backdrop)
        .bind(Utc::now().to_rfc3339())
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    /// Add a show's episodes from TMDB and update their stills. The text of episodes already
    /// stored is left alone: it's picked from every provider's answers
    /// (`set_shown_episodes`), so it isn't written twice.
    pub async fn upsert_episodes(&self, metadata_id: i64, episodes: &[NewEpisode]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for e in episodes {
            sqlx::query(
                "INSERT INTO episode_metadata (metadata_id, season, episode, name, overview, air_date, still)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (metadata_id, season, episode) DO UPDATE SET still = excluded.still
                 WHERE still IS NOT excluded.still",
            )
            .bind(metadata_id)
            .bind(e.season)
            .bind(e.episode)
            .bind(&e.name)
            .bind(&e.overview)
            .bind(&e.air_date)
            .bind(&e.still)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Fill in the episode number of a title-only file once its name matched TMDB.
    pub async fn set_item_episode(&self, item_id: i64, episode: i64) -> Result<()> {
        sqlx::query("UPDATE items SET episode = ? WHERE id = ?")
            .bind(episode)
            .bind(item_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Attach items to a metadata row (or record a failed attempt when `metadata_id` is `None`).
    pub async fn set_item_metadata(&self, item_ids: &[i64], metadata_id: Option<i64>) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        for id in item_ids {
            sqlx::query("UPDATE items SET metadata_id = ?, match_attempted_at = ? WHERE id = ?")
                .bind(metadata_id)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

impl Db {
    /// Cached artwork still stored as JPEG (for the one-time WebP migration).
    pub async fn jpeg_image_keys(&self) -> Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT poster FROM metadata WHERE poster LIKE '%.jpg'
             UNION SELECT backdrop FROM metadata WHERE backdrop LIKE '%.jpg'",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// Point every reference to an image cache key at its replacement.
    pub async fn rename_image_key(&self, old: &str, new: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE metadata SET poster = ? WHERE poster = ?")
            .bind(new)
            .bind(old)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE metadata SET backdrop = ? WHERE backdrop = ?")
            .bind(new)
            .bind(old)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

fn retry_cutoff() -> String {
    (Utc::now() - Duration::days(RETRY_UNMATCHED_AFTER_DAYS)).to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn a_titles_logo_is_remembered_even_when_there_is_none() {
        let db = Db::in_memory().await.unwrap();
        db.set_title_logo("movie", 603, Some("w500_x.webp"), 1).await.unwrap();
        db.set_title_logo("series", 603, None, 2).await.unwrap();
        let movies = db.title_logos("movie", &[603, 604]).await.unwrap();
        assert_eq!(movies.get(&603), Some(&(Some("w500_x.webp".to_string()), 1)));
        assert!(!movies.contains_key(&604), "never asked");
        assert_eq!(
            db.title_logos("series", &[603]).await.unwrap().get(&603),
            Some(&(None, 2)),
            "none, remembered"
        );
    }

    #[tokio::test]
    async fn a_season_can_come_from_another_show() {
        let db = Db::in_memory().await.unwrap();
        let m = SeasonMatch {
            folder: "monster 2022".into(),
            season: 3,
            tmdb_id: 286_801,
            tmdb_season: 1,
            title: "Monster: The Ed Gein Story".into(),
            poster: None,
            backdrop: Some("w1280_x.webp".into()),
            overview: None,
            year: Some(2025),
        };
        db.set_season_match(&m, 1).await.unwrap();
        db.set_season_match(&SeasonMatch { tmdb_season: 2, ..m.clone() }, 2).await.unwrap();
        let got = db.season_matches("monster 2022").await.unwrap();
        assert_eq!(got.len(), 1, "one match per season, the latest");
        assert_eq!(got[0].tmdb_season, 2);
        assert!(db.season_matches("monster").await.unwrap().is_empty(), "another folder");
        assert!(db.delete_season_match("monster 2022", 3).await.unwrap());
        assert!(!db.delete_season_match("monster 2022", 3).await.unwrap());
    }

    #[tokio::test]
    async fn hand_fixed_matches_are_remembered_by_name() {
        let db = Db::in_memory().await.unwrap();
        assert_eq!(db.match_override(MetadataKind::Series, "the legend of korra").await.unwrap(), None);
        db.set_match_override(MetadataKind::Series, "the legend of korra", 1, 10).await.unwrap();
        db.set_match_override(MetadataKind::Series, "the legend of korra", 33880, 11).await.unwrap();
        assert_eq!(
            db.match_override(MetadataKind::Series, "the legend of korra").await.unwrap(),
            Some(33880)
        );
        assert_eq!(
            db.match_override(MetadataKind::Movie, "the legend of korra").await.unwrap(),
            None,
            "per kind"
        );
    }
}
