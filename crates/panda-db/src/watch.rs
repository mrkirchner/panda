//! Per-user watch progress. See migration 0005 for how keys are formed.

use serde::Serialize;

use crate::{Db, Result};

/// Finished at this fraction of the runtime (end credits).
pub const FINISHED_FRACTION: f64 = 0.9;
/// Shorter plays aren't recorded as "in progress" (accidental starts).
pub const MIN_PROGRESS_SECS: f64 = 15.0;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WatchState {
    pub watch_key: String,
    pub item_id: i64,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub finished: bool,
    pub play_count: i64,
    pub last_played_at: i64,
}

impl WatchState {
    /// 0.0-1.0 through the title (0 when finished: it would be watched from the start again).
    pub fn fraction(&self) -> f64 {
        match self.duration_secs {
            Some(d) if d > 0.0 && !self.finished => (self.position_secs / d).clamp(0.0, 1.0),
            _ => 0.0,
        }
    }

    pub fn in_progress(&self) -> bool {
        !self.finished && self.position_secs >= MIN_PROGRESS_SECS
    }
}

impl Db {
    /// Record playback position. Crossing [`FINISHED_FRACTION`] marks it watched (once).
    pub async fn record_progress(
        &self,
        user_id: i64,
        key: &str,
        item_id: i64,
        position_secs: f64,
        duration_secs: Option<f64>,
        now: i64,
    ) -> Result<WatchState> {
        let finished = duration_secs.is_some_and(|d| d > 0.0 && position_secs >= d * FINISHED_FRACTION);
        let existing = self.watch_state(user_id, key).await?;
        if !finished && position_secs < MIN_PROGRESS_SECS && existing.is_none() {
            // Don't clutter Continue Watching with things barely started.
            return Ok(WatchState {
                watch_key: key.to_string(),
                item_id,
                position_secs,
                duration_secs,
                finished: false,
                play_count: 0,
                last_played_at: now,
            });
        }
        let newly_finished =
            finished && !existing.as_ref().is_some_and(|e| e.finished && e.position_secs == 0.0);
        Ok(sqlx::query_as(
            "INSERT INTO watch_state (user_id, watch_key, item_id, position_secs, duration_secs, finished,
                                      play_count, last_played_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, watch_key) DO UPDATE SET
                item_id = excluded.item_id, position_secs = excluded.position_secs,
                duration_secs = COALESCE(excluded.duration_secs, watch_state.duration_secs),
                finished = CASE WHEN excluded.finished = 1 THEN 1
                                WHEN excluded.position_secs >= ? THEN 0
                                ELSE watch_state.finished END,
                -- Decided against the stored row (not an earlier read), so two saves crossing the
                -- line at once count one play: the second sees it already finished.
                play_count = watch_state.play_count
                    + CASE WHEN excluded.finished = 1
                                AND NOT (watch_state.finished = 1 AND watch_state.position_secs = 0.0)
                           THEN 1 ELSE 0 END,
                last_played_at = excluded.last_played_at
             RETURNING watch_key, item_id, position_secs, duration_secs, finished, play_count, last_played_at",
        )
        .bind(user_id)
        .bind(key)
        .bind(item_id)
        // Finished: resume from the start next time.
        .bind(if finished { 0.0 } else { position_secs })
        .bind(duration_secs)
        .bind(finished)
        .bind(i64::from(newly_finished))
        .bind(now)
        // A rewatch past the threshold clears "finished" so it shows in Continue Watching.
        .bind(MIN_PROGRESS_SECS)
        .fetch_one(&self.pool)
        .await?)
    }

    /// Mark watched / unwatched by hand.
    pub async fn set_watched(
        &self,
        user_id: i64,
        key: &str,
        item_id: i64,
        watched: bool,
        now: i64,
    ) -> Result<()> {
        if watched {
            sqlx::query(
                "INSERT INTO watch_state (user_id, watch_key, item_id, position_secs, finished, play_count, last_played_at)
                 VALUES (?, ?, ?, 0, 1, 1, ?)
                 ON CONFLICT (user_id, watch_key) DO UPDATE SET finished = 1, position_secs = 0,
                    play_count = MAX(watch_state.play_count, 1), last_played_at = excluded.last_played_at",
            )
            .bind(user_id)
            .bind(key)
            .bind(item_id)
            .bind(now)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query("DELETE FROM watch_state WHERE user_id = ? AND watch_key = ?")
                .bind(user_id)
                .bind(key)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn watch_state(&self, user_id: i64, key: &str) -> Result<Option<WatchState>> {
        Ok(sqlx::query_as(
            "SELECT watch_key, item_id, position_secs, duration_secs, finished, play_count, last_played_at
             FROM watch_state WHERE user_id = ? AND watch_key = ?",
        )
        .bind(user_id)
        .bind(key)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// All of a user's watch states, most recently played first.
    pub async fn watch_states(&self, user_id: i64) -> Result<Vec<WatchState>> {
        Ok(sqlx::query_as(
            "SELECT watch_key, item_id, position_secs, duration_secs, finished, play_count, last_played_at
             FROM watch_state WHERE user_id = ? ORDER BY last_played_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn progress_lifecycle() {
        let db = Db::in_memory().await.unwrap();
        let u = db.create_first_admin("ben", "h", 0).await.unwrap().unwrap().id;
        // Barely started: not recorded.
        db.record_progress(u, "m603", 1, 5.0, Some(6000.0), 10).await.unwrap();
        assert!(db.watch_state(u, "m603").await.unwrap().is_none());
        // Real progress, then switching to another version (item 2) of the same movie.
        db.record_progress(u, "m603", 1, 1200.0, Some(6000.0), 20).await.unwrap();
        let s = db.record_progress(u, "m603", 2, 1500.0, None, 30).await.unwrap();
        assert!(s.in_progress() && s.item_id == 2);
        assert!((s.fraction() - 0.25).abs() < 1e-9, "duration kept from earlier");
        // Crossing 90%: finished, resume resets, counted once.
        let s = db.record_progress(u, "m603", 2, 5500.0, Some(6000.0), 40).await.unwrap();
        assert!(s.finished && s.position_secs == 0.0 && s.play_count == 1);
        let s = db.record_progress(u, "m603", 2, 5600.0, Some(6000.0), 50).await.unwrap();
        assert_eq!(s.play_count, 1, "still the same viewing");
        // Rewatching clears "finished" once past the threshold.
        let s = db.record_progress(u, "m603", 2, 60.0, Some(6000.0), 60).await.unwrap();
        assert!(!s.finished && s.in_progress());
        // Manual mark/unmark.
        db.set_watched(u, "m603", 2, false, 70).await.unwrap();
        assert!(db.watch_state(u, "m603").await.unwrap().is_none());
        db.set_watched(u, "m603", 2, true, 80).await.unwrap();
        assert!(db.watch_state(u, "m603").await.unwrap().unwrap().finished);
        assert_eq!(db.watch_states(u).await.unwrap().len(), 1);
    }
}
