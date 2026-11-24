//! Titles' age ratings (`metadata.certification` / `rating_age`) and profiles' age limits
//! (`users.max_age`).

use crate::{Db, Result};

/// A title whose rating is to be looked up: its row, kind and TMDB id.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ToRate {
    pub id: i64,
    pub kind: String,
    pub tmdb_id: i64,
}

impl Db {
    /// Titles not rated for `region` yet, or rated before `stale_before` (newest first).
    pub async fn titles_to_rate(&self, region: &str, stale_before: i64, limit: i64) -> Result<Vec<ToRate>> {
        Ok(sqlx::query_as(
            "SELECT id, kind, tmdb_id FROM metadata
             WHERE rated_region IS NOT ? OR rated_at IS NULL OR rated_at < ?
             ORDER BY id DESC LIMIT ?",
        )
        .bind(region)
        .bind(stale_before)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// A title's rating as shown and its age (both `None`: TMDB has none it could read).
    pub async fn set_title_rating(
        &self,
        id: i64,
        certification: Option<&str>,
        age: Option<i64>,
        region: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE metadata SET certification = ?, rating_age = ?, rated_region = ?, rated_at = ? WHERE id = ?",
        )
        .bind(certification)
        .bind(age)
        .bind(region)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A TMDB title's rating age, if it's in the library and rated (`kind`: movie or series).
    pub async fn rating_age_of(&self, kind: &str, tmdb_id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<i64>,)> =
            sqlx::query_as("SELECT rating_age FROM metadata WHERE kind = ? AND tmdb_id = ?")
                .bind(kind)
                .bind(tmdb_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(a,)| a))
    }

    /// The account's parental PIN hash (on the owner's row), if set.
    pub async fn parental_pin_hash(&self, account_id: i64) -> Result<Option<String>> {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT parental_pin_hash FROM users WHERE id = ?")
                .bind(account_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(h,)| h))
    }

    pub async fn set_parental_pin(&self, account_id: i64, pin_hash: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE users SET parental_pin_hash = ? WHERE id = ?")
            .bind(pin_hash)
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A profile's age limit (`None`: none).
    pub async fn set_max_age(&self, user_id: i64, max_age: Option<i64>) -> Result<()> {
        sqlx::query("UPDATE users SET max_age = ? WHERE id = ?")
            .bind(max_age)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
