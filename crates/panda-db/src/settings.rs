//! Key/value settings. Encryption of secret values is the caller's job (`panda-auth`'s
//! `SecretBox`); this module only records whether a value is ciphertext.

use crate::{Db, Result};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub encrypted: bool,
    pub updated_at: i64,
}

impl Db {
    pub async fn setting(&self, key: &str) -> Result<Option<Setting>> {
        Ok(sqlx::query_as("SELECT key, value, encrypted, updated_at FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn set_setting(&self, key: &str, value: &str, encrypted: bool, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted,
                                             updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(encrypted)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_setting(&self, key: &str) -> Result<()> {
        sqlx::query("DELETE FROM settings WHERE key = ?").bind(key).execute(&self.pool).await?;
        Ok(())
    }
}
