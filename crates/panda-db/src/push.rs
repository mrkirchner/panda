//! Web Push subscriptions: a browser of a profile that asked to be told (the web app).

use serde::Serialize;
use sqlx::FromRow;

use crate::{Db, Result};

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct PushSubscription {
    pub id: i64,
    pub user_id: i64,
    pub endpoint: String,
    /// The browser's public key and auth secret (base64url), to encrypt for it.
    pub p256dh: String,
    pub auth: String,
}

impl Db {
    /// Keep (or move to this profile) a browser's subscription.
    pub async fn save_push_subscription(
        &self,
        user_id: i64,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
        )
        .bind(user_id)
        .bind(endpoint)
        .bind(p256dh)
        .bind(auth)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn push_subscriptions(&self, user_id: i64) -> Result<Vec<PushSubscription>> {
        Ok(sqlx::query_as(
            "SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Forget one: unsubscribed in the browser (only its own profile may), or gone at the push
    /// service (404/410).
    pub async fn delete_push_subscription(&self, endpoint: &str, user_id: Option<i64>) -> Result<()> {
        match user_id {
            Some(uid) => sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
                .bind(endpoint)
                .bind(uid),
            None => sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint),
        }
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
