//! What each metadata provider said, kept apart (`provider_values`), and when titles were last
//! looked up at the extra providers (`provider_fetches`). `panda-server` picks the shown values
//! from these by the admin's provider order and writes them into `metadata`/`episode_metadata`.

use std::collections::BTreeSet;

use crate::{Db, MetadataKind, NewEpisode, Result};

/// `season`/`episode` of a value about the title itself.
pub const TITLE_LEVEL: i64 = -1;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct ProviderValue {
    pub provider: String,
    pub season: i64,
    pub episode: i64,
    /// `overview`, `name`, `air_date` or `rating.<source>`.
    pub field: String,
    pub value: String,
}

impl ProviderValue {
    /// About the title itself, not one of its episodes.
    pub fn is_title(&self) -> bool {
        self.season == TITLE_LEVEL
    }
}

/// A matched title (with files) due for a lookup at an extra provider.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StaleTitle {
    pub metadata_id: i64,
    pub kind: MetadataKind,
    pub tmdb_id: i64,
    /// Its ids elsewhere, when they're stored (from TMDB, at matching).
    pub imdb_id: Option<String>,
    pub tvdb_id: Option<i64>,
}

/// Which of a title's shown pictures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artwork {
    Poster,
    Backdrop,
}

/// An episode's shown text, picked from the providers' values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownEpisode {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
}

impl From<&NewEpisode> for ShownEpisode {
    fn from(e: &NewEpisode) -> Self {
        Self {
            season: e.season,
            episode: e.episode,
            name: e.name.clone(),
            overview: e.overview.clone(),
            air_date: e.air_date.clone(),
        }
    }
}

impl Db {
    /// Replace what `provider` said about the title itself: `(field, value)` pairs.
    pub async fn replace_title_values(
        &self,
        metadata_id: i64,
        provider: &str,
        values: &[(String, String)],
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM provider_values WHERE metadata_id = ? AND provider = ? AND season = ?")
            .bind(metadata_id)
            .bind(provider)
            .bind(TITLE_LEVEL)
            .execute(&mut *tx)
            .await?;
        for (field, value) in values {
            sqlx::query(
                "INSERT OR REPLACE INTO provider_values (metadata_id, provider, season, episode, field, value)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(metadata_id)
            .bind(provider)
            .bind(TITLE_LEVEL)
            .bind(TITLE_LEVEL)
            .bind(field)
            .bind(value)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Replace what `provider` said about the episodes of `seasons` (values of other seasons are
    /// ignored).
    pub async fn replace_episode_values(
        &self,
        metadata_id: i64,
        provider: &str,
        seasons: &BTreeSet<i64>,
        values: &[ProviderValue],
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for season in seasons {
            sqlx::query("DELETE FROM provider_values WHERE metadata_id = ? AND provider = ? AND season = ?")
                .bind(metadata_id)
                .bind(provider)
                .bind(season)
                .execute(&mut *tx)
                .await?;
        }
        for v in values.iter().filter(|v| seasons.contains(&v.season) && v.episode >= 0) {
            sqlx::query(
                "INSERT OR REPLACE INTO provider_values (metadata_id, provider, season, episode, field, value)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(metadata_id)
            .bind(provider)
            .bind(v.season)
            .bind(v.episode)
            .bind(&v.field)
            .bind(&v.value)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Everything every provider said about a title and its episodes.
    pub async fn provider_values(&self, metadata_id: i64) -> Result<Vec<ProviderValue>> {
        Ok(sqlx::query_as(
            "SELECT provider, season, episode, field, value FROM provider_values WHERE metadata_id = ?",
        )
        .bind(metadata_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Every stored answer, with its title (to re-pick every title in one read).
    pub async fn all_provider_values(&self) -> Result<Vec<(i64, ProviderValue)>> {
        #[derive(sqlx::FromRow)]
        struct Row {
            metadata_id: i64,
            #[sqlx(flatten)]
            value: ProviderValue,
        }
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT metadata_id, provider, season, episode, field, value FROM provider_values
             ORDER BY metadata_id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| (r.metadata_id, r.value)).collect())
    }

    /// Every show's seasons with files: `(metadata_id, season)`.
    pub async fn all_metadata_seasons(&self) -> Result<Vec<(i64, i64)>> {
        Ok(sqlx::query_as(
            "SELECT DISTINCT metadata_id, season FROM items
             WHERE metadata_id IS NOT NULL AND season IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// A title's `provider` answers are out of date (new episodes): ask it again first.
    pub async fn forget_provider_fetch(&self, metadata_id: i64, provider: &str) -> Result<()> {
        sqlx::query("DELETE FROM provider_fetches WHERE metadata_id = ? AND provider = ?")
            .bind(metadata_id)
            .bind(provider)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Store a title's ids elsewhere (from TMDB).
    pub async fn set_title_ids(
        &self,
        metadata_id: i64,
        imdb_id: Option<&str>,
        tvdb_id: Option<i64>,
    ) -> Result<()> {
        sqlx::query("UPDATE metadata SET imdb_id = ?, tvdb_id = ? WHERE id = ?")
            .bind(imdb_id)
            .bind(tvdb_id)
            .bind(metadata_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A title's TMDB score, when it has one.
    pub async fn title_rating(&self, kind: MetadataKind, tmdb_id: i64) -> Result<Option<f64>> {
        Ok(sqlx::query_scalar("SELECT rating FROM metadata WHERE kind = ? AND tmdb_id = ?")
            .bind(kind)
            .bind(tmdb_id)
            .fetch_optional(&self.pool)
            .await?
            .flatten())
    }

    pub async fn record_provider_fetch(&self, metadata_id: i64, provider: &str, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO provider_fetches (metadata_id, provider, fetched_at) VALUES (?, ?, ?)",
        )
        .bind(metadata_id)
        .bind(provider)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Matched titles with files that `provider` hasn't been asked about since `before` (never
    /// asked first), at most `limit`. `series_only` for providers without movies.
    pub async fn stale_for_provider(
        &self,
        provider: &str,
        series_only: bool,
        before: i64,
        limit: i64,
    ) -> Result<Vec<StaleTitle>> {
        Ok(sqlx::query_as(
            "SELECT m.id AS metadata_id, m.kind, m.tmdb_id, m.imdb_id, m.tvdb_id FROM metadata m
             LEFT JOIN provider_fetches f ON f.metadata_id = m.id AND f.provider = ?
             WHERE (f.fetched_at IS NULL OR f.fetched_at < ?)
               AND (? = 0 OR m.kind = 'series')
               AND EXISTS (SELECT 1 FROM items i WHERE i.metadata_id = m.id)
             ORDER BY f.fetched_at IS NOT NULL, f.fetched_at
             LIMIT ?",
        )
        .bind(provider)
        .bind(before)
        .bind(series_only)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// The seasons of a show that have files.
    pub async fn metadata_seasons(&self, metadata_id: i64) -> Result<Vec<i64>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT season FROM items WHERE metadata_id = ? AND season IS NOT NULL ORDER BY season",
        )
        .bind(metadata_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// The folder names a show's files are in.
    pub async fn metadata_folders(&self, metadata_id: i64) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT series FROM items WHERE metadata_id = ? AND series IS NOT NULL",
        )
        .bind(metadata_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// What `provider` said about a title itself (not its episodes): `(field, value)`.
    pub async fn title_values(
        &self,
        kind: MetadataKind,
        tmdb_id: i64,
        provider: &str,
    ) -> Result<Vec<(String, String)>> {
        Ok(sqlx::query_as(
            "SELECT v.field, v.value FROM metadata m
             JOIN provider_values v ON v.metadata_id = m.id AND v.season = ? AND v.episode = ?
             WHERE m.kind = ? AND m.tmdb_id = ? AND v.provider = ?",
        )
        .bind(TITLE_LEVEL)
        .bind(TITLE_LEVEL)
        .bind(kind)
        .bind(tmdb_id)
        .bind(provider)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Set a title's shown plot (unchanged rows aren't written, so the catalog doesn't rebuild).
    pub async fn set_shown_overview(&self, metadata_id: i64, overview: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE metadata SET overview = ? WHERE id = ? AND overview IS NOT ?")
            .bind(overview)
            .bind(metadata_id)
            .bind(overview)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Set a title's shown poster or backdrop (an image cache key; unchanged rows aren't
    /// written, so the catalog doesn't rebuild).
    pub async fn set_shown_artwork(&self, metadata_id: i64, art: Artwork, key: Option<&str>) -> Result<()> {
        let sql = match art {
            Artwork::Poster => "UPDATE metadata SET poster = ? WHERE id = ? AND poster IS NOT ?",
            Artwork::Backdrop => "UPDATE metadata SET backdrop = ? WHERE id = ? AND backdrop IS NOT ?",
        };
        sqlx::query(sql).bind(key).bind(metadata_id).bind(key).execute(&self.pool).await?;
        Ok(())
    }

    /// Set the shown episodes of `seasons`: their text (adding episodes only some provider
    /// knows; stills are kept), and drop episodes no longer shown that only another provider had
    /// listed (no TMDB answer and no still), e.g. after that provider was turned off.
    pub async fn set_shown_episodes(
        &self,
        metadata_id: i64,
        seasons: &BTreeSet<i64>,
        episodes: &[ShownEpisode],
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for &season in seasons {
            let stored: Vec<i64> = sqlx::query_scalar(
                "SELECT episode FROM episode_metadata WHERE metadata_id = ? AND season = ?",
            )
            .bind(metadata_id)
            .bind(season)
            .fetch_all(&mut *tx)
            .await?;
            for episode in stored {
                if episodes.iter().any(|e| e.season == season && e.episode == episode) {
                    continue;
                }
                sqlx::query(
                    "DELETE FROM episode_metadata
                     WHERE metadata_id = ? AND season = ? AND episode = ? AND still IS NULL
                       AND NOT EXISTS (SELECT 1 FROM provider_values v
                                       WHERE v.metadata_id = episode_metadata.metadata_id
                                         AND v.season = episode_metadata.season
                                         AND v.episode = episode_metadata.episode AND v.provider = 'tmdb')",
                )
                .bind(metadata_id)
                .bind(season)
                .bind(episode)
                .execute(&mut *tx)
                .await?;
            }
        }
        for e in episodes {
            sqlx::query(
                "INSERT INTO episode_metadata (metadata_id, season, episode, name, overview, air_date)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (metadata_id, season, episode) DO UPDATE SET
                    name = excluded.name, overview = excluded.overview, air_date = excluded.air_date
                 WHERE name IS NOT excluded.name OR overview IS NOT excluded.overview
                    OR air_date IS NOT excluded.air_date",
            )
            .bind(metadata_id)
            .bind(e.season)
            .bind(e.episode)
            .bind(&e.name)
            .bind(&e.overview)
            .bind(&e.air_date)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewMetadata;

    async fn show(db: &Db) -> i64 {
        db.upsert_metadata(&NewMetadata {
            kind: MetadataKind::Series,
            tmdb_id: 1396,
            title: "Show".into(),
            original_title: None,
            year: None,
            overview: Some("From TMDB.".into()),
            tagline: None,
            genres: None,
            runtime_mins: None,
            rating: None,
            poster: None,
            backdrop: None,
        })
        .await
        .unwrap()
    }

    fn v(provider: &str, season: i64, episode: i64, field: &str, value: &str) -> ProviderValue {
        ProviderValue { provider: provider.into(), season, episode, field: field.into(), value: value.into() }
    }

    #[tokio::test]
    async fn values_replace_per_provider_and_season() {
        let db = Db::in_memory().await.unwrap();
        let id = show(&db).await;
        db.replace_episode_values(
            id,
            "tmdb",
            &BTreeSet::from([1, 2]),
            &[v("tmdb", 1, 1, "name", "A"), v("tmdb", 2, 1, "name", "B")],
        )
        .await
        .unwrap();
        db.replace_episode_values(id, "tvmaze", &BTreeSet::from([1]), &[v("tvmaze", 1, 1, "name", "A2")])
            .await
            .unwrap();
        // TMDB again, season 1 only: season 2 and TVmaze's values stay.
        db.replace_episode_values(id, "tmdb", &BTreeSet::from([1]), &[v("tmdb", 1, 1, "name", "A1")])
            .await
            .unwrap();
        db.replace_title_values(id, "omdb", &[("rating.imdb".into(), "8.0/10".into())]).await.unwrap();
        let mut got = db.provider_values(id).await.unwrap();
        got.sort_by(|a, b| (&a.provider, a.season, a.episode).cmp(&(&b.provider, b.season, b.episode)));
        assert_eq!(
            got,
            vec![
                v("omdb", -1, -1, "rating.imdb", "8.0/10"),
                v("tmdb", 1, 1, "name", "A1"),
                v("tmdb", 2, 1, "name", "B"),
                v("tvmaze", 1, 1, "name", "A2"),
            ]
        );
        assert_eq!(db.all_provider_values().await.unwrap().len(), 4);
        assert_eq!(
            db.title_values(MetadataKind::Series, 1396, "omdb").await.unwrap(),
            vec![("rating.imdb".to_string(), "8.0/10".to_string())]
        );
        // A season cleared (now from another show) forgets every provider's answers about it.
        db.clear_season_episodes(id, 1).await.unwrap();
        assert!(db.provider_values(id).await.unwrap().iter().all(|v| v.season != 1));
    }

    #[tokio::test]
    async fn shown_values_keep_stills() {
        let db = Db::in_memory().await.unwrap();
        let id = show(&db).await;
        db.upsert_episodes(
            id,
            &[crate::NewEpisode {
                season: 1,
                episode: 1,
                name: Some("Episode 1".into()),
                overview: None,
                air_date: None,
                still: Some("/still.jpg".into()),
            }],
        )
        .await
        .unwrap();
        let shown = |n: i64, name: &str| ShownEpisode {
            season: 1,
            episode: n,
            name: Some(name.into()),
            overview: Some("Plot.".into()),
            air_date: None,
        };
        db.set_shown_episodes(id, &BTreeSet::from([1]), &[shown(1, "Pilot"), shown(2, "Two")]).await.unwrap();
        let rows: Vec<(i64, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT episode, name, still FROM episode_metadata WHERE metadata_id = ? ORDER BY episode",
        )
        .bind(id)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![(1, Some("Pilot".into()), Some("/still.jpg".into())), (2, Some("Two".into()), None)]
        );
        // Episode 2 is no longer shown (its provider was turned off): it goes. Episode 1 has a
        // still from TMDB, so it stays.
        db.set_shown_episodes(id, &BTreeSet::from([1]), &[]).await.unwrap();
        let left: Vec<i64> = sqlx::query_scalar("SELECT episode FROM episode_metadata WHERE metadata_id = ?")
            .bind(id)
            .fetch_all(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, vec![1]);
        db.set_shown_overview(id, Some("From OMDb.")).await.unwrap();
        let o: Option<String> = sqlx::query_scalar("SELECT overview FROM metadata WHERE id = ?")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(o.as_deref(), Some("From OMDb."));
    }
}
