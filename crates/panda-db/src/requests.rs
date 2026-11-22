use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{Db, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RequestKind {
    Movie,
    Series,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RequestStatus {
    /// Waiting for an admin (used once multi-user approval exists).
    Pending,
    /// Sent to Sonarr/Radarr, waiting for download + import.
    Approved,
    /// Imported and visible in the library.
    Available,
    /// Sonarr/Radarr rejected it. See `error`.
    Failed,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MediaRequest {
    pub id: i64,
    pub kind: RequestKind,
    pub title: String,
    pub year: Option<i64>,
    pub tmdb_id: Option<i64>,
    pub tvdb_id: Option<i64>,
    pub status: RequestStatus,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Who asked (`None` for requests made before requests had owners).
    pub user_id: Option<i64>,
    /// Artwork key for the poster, shown on the TV until the title is in the library.
    pub poster: Option<String>,
    /// Added to the requester's My List once its title reached the library.
    pub listed: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRequest {
    pub kind: RequestKind,
    pub title: String,
    pub year: Option<i64>,
    pub tmdb_id: Option<i64>,
    pub tvdb_id: Option<i64>,
    /// Set by the server from the signed-in profile, never from the request body.
    #[serde(skip)]
    pub user_id: Option<i64>,
    /// Artwork key (as returned by search).
    #[serde(default)]
    pub poster: Option<String>,
    /// Shows: only these seasons (`None`: all). Sent to Sonarr, not stored.
    #[serde(default)]
    pub seasons: Option<Vec<i64>>,
}

macro_rules! request_columns {
    () => {
        "id, kind, title, year, tmdb_id, tvdb_id, status, error, created_at, updated_at, user_id, poster, listed"
    };
}

impl Db {
    pub async fn create_request(&self, r: &NewRequest) -> Result<MediaRequest> {
        let now = Utc::now().to_rfc3339();
        Ok(sqlx::query_as(concat!(
            "INSERT INTO requests (kind, title, year, tmdb_id, tvdb_id, status, created_at, updated_at,
                                   user_id, poster)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) RETURNING ",
            request_columns!()
        ))
        .bind(r.kind)
        .bind(&r.title)
        .bind(r.year)
        .bind(r.tmdb_id)
        .bind(r.tvdb_id)
        .bind(&now)
        .bind(&now)
        .bind(r.user_id)
        .bind(&r.poster)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn set_request_status(
        &self,
        id: i64,
        status: RequestStatus,
        error: Option<&str>,
    ) -> Result<()> {
        sqlx::query("UPDATE requests SET status = ?, error = ?, updated_at = ? WHERE id = ?")
            .bind(status)
            .bind(error)
            .bind(Utc::now().to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Mark an approved request available after Sonarr/Radarr reports an import.
    pub async fn fulfill_request(&self, kind: RequestKind, external_id: i64) -> Result<u64> {
        let sql = match kind {
            RequestKind::Movie => {
                "UPDATE requests SET status = 'available', updated_at = ?
                 WHERE kind = ? AND tmdb_id = ? AND status = 'approved'"
            }
            RequestKind::Series => {
                "UPDATE requests SET status = 'available', updated_at = ?
                 WHERE kind = ? AND tvdb_id = ? AND status = 'approved'"
            }
        };
        let res = sqlx::query(sql)
            .bind(Utc::now().to_rfc3339())
            .bind(kind)
            .bind(external_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    /// One profile's requests, newest first.
    /// Note that a request's title joined its requester's My List (done once).
    pub async fn mark_request_listed(&self, id: i64) -> Result<()> {
        sqlx::query("UPDATE requests SET listed = 1 WHERE id = ?").bind(id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn requests_for_user(&self, user_id: i64) -> Result<Vec<MediaRequest>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            request_columns!(),
            " FROM requests WHERE user_id = ? ORDER BY created_at DESC"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Forget a request (cancelled). Returns whether there was one.
    pub async fn delete_request(&self, id: i64) -> Result<bool> {
        let r = sqlx::query("DELETE FROM requests WHERE id = ?").bind(id).execute(&self.pool).await?;
        Ok(r.rows_affected() > 0)
    }

    pub async fn requests(&self) -> Result<Vec<MediaRequest>> {
        Ok(sqlx::query_as(concat!("SELECT ", request_columns!(), " FROM requests ORDER BY created_at DESC"))
            .fetch_all(&self.pool)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_lifecycle() {
        let db = Db::in_memory().await.unwrap();
        let r = db
            .create_request(&NewRequest {
                kind: RequestKind::Movie,
                title: "Heat".into(),
                year: Some(1995),
                tmdb_id: Some(949),
                tvdb_id: None,
                user_id: None,
                poster: None,
                seasons: None,
            })
            .await
            .unwrap();
        assert_eq!(r.status, RequestStatus::Pending);
        db.set_request_status(r.id, RequestStatus::Approved, None).await.unwrap();
        assert_eq!(db.fulfill_request(RequestKind::Movie, 949).await.unwrap(), 1);
        assert_eq!(db.requests().await.unwrap()[0].status, RequestStatus::Available);
    }
}
