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
    /// When its title arrived in the library (unix seconds), for telling the requester.
    pub ready_at: Option<i64>,
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
        "id, kind, title, year, tmdb_id, tvdb_id, status, error, created_at, updated_at, user_id, poster, listed, ready_at"
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

    /// Requests whose title hasn't arrived yet (and that someone is waiting for).
    pub async fn waiting_requests(&self) -> Result<Vec<MediaRequest>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            request_columns!(),
            " FROM requests WHERE ready_at IS NULL AND user_id IS NOT NULL AND status != 'failed'"
        ))
        .fetch_all(&self.pool)
        .await?)
    }

    /// Its title is in the library now: available, and news for the requester.
    pub async fn mark_request_ready(&self, id: i64, now: i64) -> Result<()> {
        sqlx::query("UPDATE requests SET ready_at = ?, status = 'available', updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(Utc::now().to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// This profile's arrivals since `since` (unix seconds) not looked at yet, newest first.
    pub async fn unseen_ready(&self, user_id: i64, since: i64) -> Result<Vec<MediaRequest>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            request_columns!(),
            " FROM requests WHERE user_id = ? AND ready_at >= ? AND ready_seen = 0 ORDER BY ready_at DESC"
        ))
        .bind(user_id)
        .bind(since)
        .fetch_all(&self.pool)
        .await?)
    }

    /// The profile opened this title's page: its arrival has been seen.
    pub async fn mark_ready_seen_title(&self, user_id: i64, kind: RequestKind, tmdb_id: i64) -> Result<()> {
        sqlx::query(
            "UPDATE requests SET ready_seen = 1
             WHERE user_id = ? AND kind = ? AND tmdb_id = ? AND ready_at IS NOT NULL AND ready_seen = 0",
        )
        .bind(user_id)
        .bind(kind)
        .bind(tmdb_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Shown: only this profile's own requests (another's id does nothing).
    pub async fn mark_ready_seen(&self, user_id: i64, id: i64) -> Result<()> {
        sqlx::query("UPDATE requests SET ready_seen = 1 WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Arrivals not emailed yet.
    pub async fn unemailed_ready(&self) -> Result<Vec<MediaRequest>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            request_columns!(),
            " FROM requests WHERE ready_at IS NOT NULL AND ready_emailed = 0 AND user_id IS NOT NULL"
        ))
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn mark_ready_emailed(&self, id: i64) -> Result<()> {
        sqlx::query("UPDATE requests SET ready_emailed = 1 WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
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

    #[tokio::test]
    async fn an_arrival_is_news_for_its_requester_until_seen() {
        let db = Db::in_memory().await.unwrap();
        let owner = db.create_first_admin("owner", "x", 0).await.unwrap().unwrap();
        let kid = db.create_managed_profile(owner.id, "kid", Some("Kid"), "x", 0).await.unwrap();
        let r = db
            .create_request(&NewRequest {
                kind: RequestKind::Movie,
                title: "Heat".into(),
                year: Some(1995),
                tmdb_id: Some(949),
                tvdb_id: None,
                user_id: Some(kid.id),
                poster: None,
                seasons: None,
            })
            .await
            .unwrap();
        assert_eq!(db.waiting_requests().await.unwrap().len(), 1);
        db.mark_request_ready(r.id, 1000).await.unwrap();
        assert!(db.waiting_requests().await.unwrap().is_empty());
        assert_eq!(db.unseen_ready(kid.id, 0).await.unwrap().len(), 1);
        assert!(db.unseen_ready(kid.id, 2000).await.unwrap().is_empty(), "older than `since`");
        assert_eq!(db.unemailed_ready().await.unwrap().len(), 1);
        // Another profile's "seen" does nothing; the requester's does.
        db.mark_ready_seen(owner.id, r.id).await.unwrap();
        assert_eq!(db.unseen_ready(kid.id, 0).await.unwrap().len(), 1);
        db.mark_ready_seen(kid.id, r.id).await.unwrap();
        assert!(db.unseen_ready(kid.id, 0).await.unwrap().is_empty());
        db.mark_ready_emailed(r.id).await.unwrap();
        assert!(db.unemailed_ready().await.unwrap().is_empty());
    }
}
