//! Intros and credits found in episodes' sound (`audio_markers`).

use sqlx::FromRow;

use crate::{Db, Result};

#[derive(Debug, Clone, Copy, Default, PartialEq, FromRow)]
pub struct AudioMarkers {
    pub intro_start: Option<f64>,
    pub intro_end: Option<f64>,
    pub credits_start: Option<f64>,
}

/// A season whose episodes haven't all been checked: its library, show folder and number.
#[derive(Debug, Clone, PartialEq, Eq, Hash, FromRow)]
pub struct SeasonKey {
    pub library_id: i64,
    pub series: String,
    pub season: i64,
}

impl Db {
    /// What was found in this file (`None`: not checked yet, or the file changed since).
    pub async fn audio_markers(&self, item_id: i64, size_bytes: i64) -> Result<Option<AudioMarkers>> {
        Ok(sqlx::query_as(
            "SELECT intro_start, intro_end, credits_start FROM audio_markers WHERE item_id = ? AND size_bytes = ?",
        )
        .bind(item_id)
        .bind(size_bytes)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn set_audio_markers(
        &self,
        item_id: i64,
        size_bytes: i64,
        m: AudioMarkers,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO audio_markers (item_id, size_bytes, intro_start, intro_end, credits_start, checked_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (item_id) DO UPDATE SET size_bytes = excluded.size_bytes, intro_start = excluded.intro_start,
               intro_end = excluded.intro_end, credits_start = excluded.credits_start, checked_at = excluded.checked_at",
        )
        .bind(item_id)
        .bind(size_bytes)
        .bind(m.intro_start)
        .bind(m.intro_end)
        .bind(m.credits_start)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Seasons with episodes not checked yet (newest additions first).
    pub async fn unchecked_seasons(&self, limit: i64) -> Result<Vec<SeasonKey>> {
        Ok(sqlx::query_as(
            "SELECT i.library_id, i.series, i.season FROM items i
             LEFT JOIN audio_markers m ON m.item_id = i.id AND m.size_bytes = i.size_bytes
             WHERE i.kind = 'episode' AND m.item_id IS NULL AND i.series IS NOT NULL AND i.season IS NOT NULL
               AND i.duration_secs IS NOT NULL
             GROUP BY i.library_id, i.series, i.season
             ORDER BY MAX(i.added_at) DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// One season's episodes in one library, in order.
    pub async fn season_episodes(&self, key: &SeasonKey) -> Result<Vec<crate::Item>> {
        let filter = crate::ItemFilter {
            library_id: Some(key.library_id),
            kind: Some(crate::ItemKind::Episode),
            series: Some(key.series.clone()),
            limit: Some(10_000),
            ..Default::default()
        };
        let mut eps: Vec<crate::Item> =
            self.items(&filter).await?.into_iter().filter(|i| i.season == Some(key.season)).collect();
        eps.sort_by_key(|i| (i.episode.unwrap_or(0), i.id));
        Ok(eps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProbeSummary;
    use panda_library::{LibraryKind, Parsed, ScannedFile};
    use std::path::PathBuf;

    #[tokio::test]
    async fn a_season_is_checked_once_per_file_version() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("TV", LibraryKind::Shows, "/tv").await.unwrap();
        let ep = |n: u32, size: u64| ScannedFile {
            path: PathBuf::from(format!("/tv/Show/S01E0{n}.mkv")),
            size,
            mtime: 1,
            parsed: Parsed::Episode {
                series: "Show".into(),
                season: 1,
                episode: Some(n),
                episode_end: None,
                episode_title: None,
            },
        };
        let probed = ProbeSummary { duration_secs: Some(2400.0), ..Default::default() };
        let mut ids = Vec::new();
        for n in [2, 1] {
            let up = db.upsert_item(lib.id, 1, &ep(n, 10)).await.unwrap();
            db.set_probe(up.id, &probed, "{}").await.unwrap();
            ids.push(up.id);
        }
        let key = SeasonKey { library_id: lib.id, series: "Show".into(), season: 1 };
        assert_eq!(db.unchecked_seasons(5).await.unwrap(), vec![key.clone()]);
        let eps = db.season_episodes(&key).await.unwrap();
        assert_eq!(eps.iter().map(|e| e.episode).collect::<Vec<_>>(), vec![Some(1), Some(2)], "in order");

        let found = AudioMarkers { intro_start: Some(60.0), intro_end: Some(95.0), credits_start: None };
        for e in &eps {
            db.set_audio_markers(e.id, e.size_bytes, found, 1).await.unwrap();
        }
        assert!(db.unchecked_seasons(5).await.unwrap().is_empty());
        assert_eq!(db.audio_markers(eps[0].id, 10).await.unwrap(), Some(found));
        // Replaced by another file (an upgrade): checked again.
        db.upsert_item(lib.id, 2, &ep(1, 11)).await.unwrap();
        db.set_probe(eps[0].id, &probed, "{}").await.unwrap();
        assert_eq!(db.audio_markers(eps[0].id, 11).await.unwrap(), None);
        assert_eq!(db.unchecked_seasons(5).await.unwrap(), vec![key]);
    }
}
