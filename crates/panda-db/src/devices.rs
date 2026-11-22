//! TVs: each belongs to one account and offers that account's profiles. Callers hash the device credential (`panda-auth`'s
//! `token::digest`) and PINs (Argon2id) before calling in.

use serde::Serialize;

use crate::{Db, Result};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Device {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    /// The account that paired it (its owner's user id); it lists that account's profiles.
    pub account_id: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DeviceProfile {
    pub user_id: i64,
    pub username: String,
    /// Switching to this profile needs a PIN.
    pub has_pin: bool,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
}

impl Db {
    pub async fn create_device(
        &self,
        token_hash: &str,
        name: &str,
        account_id: i64,
        now: i64,
    ) -> Result<i64> {
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO devices (token_hash, name, account_id, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(token_hash)
        .bind(name)
        .bind(account_id)
        .bind(now)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    /// Resolve a device credential (by hash), updating last-seen.
    pub async fn device_by_token(&self, token_hash: &str, now: i64) -> Result<Option<Device>> {
        Ok(sqlx::query_as(
            // A TV of a disabled account (its owner disabled) is refused like an unknown one.
            "UPDATE devices SET last_seen_at = ? WHERE token_hash = ?
               AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = devices.account_id AND o.disabled = 1)
             RETURNING id, name, created_at, last_seen_at, account_id",
        )
        .bind(now)
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Upgrade a TV session from before device pairing existed: create the device in its user's
    /// account and attach the session to it.
    /// Returns the device id, or `None` if the session isn't an unattached TV session.
    pub async fn promote_session_to_device(
        &self,
        session_id: i64,
        token_hash: &str,
        now: i64,
    ) -> Result<Option<i64>> {
        let mut tx = self.pool.begin().await?;
        let row: Option<(Option<String>, i64)> = sqlx::query_as(
            "SELECT s.name, u.account_id FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.kind = 'device' AND s.device_id IS NULL",
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((name, account_id)) = row else { return Ok(None) };
        let (device_id,): (i64,) = sqlx::query_as(
            "INSERT INTO devices (token_hash, name, account_id, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(token_hash)
        .bind(name.as_deref().unwrap_or("TV"))
        .bind(account_id)
        .bind(now)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("UPDATE sessions SET device_id = ? WHERE id = ?")
            .bind(device_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(device_id))
    }

    pub async fn device(&self, id: i64) -> Result<Option<Device>> {
        Ok(sqlx::query_as("SELECT id, name, created_at, last_seen_at, account_id FROM devices WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?)
    }

    /// The profile picker for a device: its account's enabled profiles, owner first.
    pub async fn device_profiles(&self, device_id: i64) -> Result<Vec<DeviceProfile>> {
        Ok(sqlx::query_as(
            "SELECT u.id AS user_id, u.username, u.pin_hash IS NOT NULL AS has_pin, u.display_name, u.avatar
             FROM devices d JOIN users u ON u.account_id = d.account_id AND u.disabled = 0
             JOIN users o ON o.id = d.account_id AND o.disabled = 0
             WHERE d.id = ?
             ORDER BY u.id != u.account_id, u.created_at",
        )
        .bind(device_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn devices(&self) -> Result<Vec<(Device, Vec<DeviceProfile>)>> {
        let devices: Vec<Device> = sqlx::query_as(
            "SELECT id, name, created_at, last_seen_at, account_id FROM devices ORDER BY last_seen_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(devices.len());
        for d in devices {
            let profiles = self.device_profiles(d.id).await?;
            out.push((d, profiles));
        }
        Ok(out)
    }

    /// Forget a device: its credential, profiles and sessions (cascade). The profile signed in
    /// on it also gets a new token generation, so stream and artwork links the TV still holds
    /// stop working too (a stolen or given-away TV).
    pub async fn delete_device(&self, id: i64) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE users SET token_gen = token_gen + 1
             WHERE id IN (SELECT user_id FROM sessions WHERE device_id = ?)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let deleted =
            sqlx::query("DELETE FROM devices WHERE id = ?").bind(id).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        Ok(deleted > 0)
    }

    /// New profile session on a device, ending any other session there (one active profile
    /// per TV, so a switched-away profile's token stops working).
    pub async fn start_device_session(
        &self,
        device_id: i64,
        user_id: i64,
        token_hash: &str,
        name: &str,
        now: i64,
        expires_at: i64,
    ) -> Result<i64> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM sessions WHERE device_id = ?").bind(device_id).execute(&mut *tx).await?;
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO sessions (token_hash, user_id, kind, name, created_at, last_seen_at, expires_at, device_id)
             VALUES (?, ?, 'device', ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(token_hash)
        .bind(user_id)
        .bind(name)
        .bind(now)
        .bind(now)
        .bind(expires_at)
        .bind(device_id)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
            .bind(now)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn set_pin(&self, user_id: i64, pin_hash: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE users SET pin_hash = ? WHERE id = ?")
            .bind(pin_hash)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- My List ----

    pub async fn add_favorite(&self, user_id: i64, kind: &str, reference: &str, now: i64) -> Result<()> {
        sqlx::query("INSERT OR IGNORE INTO favorites (user_id, kind, ref, added_at) VALUES (?, ?, ?, ?)")
            .bind(user_id)
            .bind(kind)
            .bind(reference)
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn remove_favorite(&self, user_id: i64, kind: &str, reference: &str) -> Result<bool> {
        Ok(sqlx::query("DELETE FROM favorites WHERE user_id = ? AND kind = ? AND ref = ?")
            .bind(user_id)
            .bind(kind)
            .bind(reference)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }

    /// (kind, ref), newest first.
    pub async fn favorites(&self, user_id: i64) -> Result<Vec<(String, String)>> {
        Ok(sqlx::query_as(
            "SELECT kind, ref FROM favorites WHERE user_id = ? ORDER BY added_at DESC, rowid DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn pin_hash(&self, user_id: i64) -> Result<Option<String>> {
        let row: Option<(Option<String>,)> = sqlx::query_as("SELECT pin_hash FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionKind;

    #[tokio::test]
    async fn profiles_and_single_active_session_per_device() {
        let db = Db::in_memory().await.unwrap();
        let ben = db.create_first_admin("ben", "h", 0).await.unwrap().unwrap().id;
        let sam = db.create_managed_profile(ben, "sam", Some("Sam"), "unusable", 1).await.unwrap().id;

        let tv = db.create_device("devhash", "Living room", ben, 1).await.unwrap();
        assert_eq!(db.device_by_token("devhash", 2).await.unwrap().unwrap().id, tv);
        assert!(db.device_by_token("wrong", 2).await.unwrap().is_none());

        db.set_pin(sam, Some("$argon2id$pin")).await.unwrap();
        let profiles = db.device_profiles(tv).await.unwrap();
        assert_eq!(
            profiles.iter().map(|p| (p.username.as_str(), p.has_pin)).collect::<Vec<_>>(),
            [("ben", false), ("sam", true)]
        );

        db.start_device_session(tv, ben, "s1", "Living room", 4, 1000).await.unwrap();
        db.start_device_session(tv, sam, "s2", "Living room", 5, 1000).await.unwrap();
        assert!(
            db.session_user("s1", 6, 0).await.unwrap().is_none(),
            "switching ends the previous profile's session"
        );
        let (s, u) = db.session_user("s2", 6, 0).await.unwrap().unwrap();
        assert_eq!((u.id, s.kind), (sam, SessionKind::Device));

        let before = db.user(sam).await.unwrap().unwrap().token_gen;
        assert!(db.delete_device(tv).await.unwrap());
        assert!(db.session_user("s2", 7, 0).await.unwrap().is_none(), "removing the TV signs everyone out");
        assert_eq!(
            db.user(sam).await.unwrap().unwrap().token_gen,
            before + 1,
            "and the links it holds stop working"
        );
        assert!(db.device_profiles(tv).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn tvs_offer_only_their_accounts_profiles() {
        let db = Db::in_memory().await.unwrap();
        let ben = db.create_first_admin("ben", "h", 0).await.unwrap().unwrap();
        assert_eq!(ben.account_id, ben.id, "the first admin owns an account");
        let kid = db.create_managed_profile(ben.id, "kid", None, "unusable", 1).await.unwrap();
        assert!(kid.managed && kid.account_id == ben.id);
        db.create_invite("friend", crate::Role::User, None, ben.id, 0, 100).await.unwrap();
        let friend = db.accept_invite("friend", "friend", "h", 3).await.unwrap().unwrap();
        assert_eq!(friend.account_id, friend.id, "an invited person owns their own account");
        let friends_kid = db.create_managed_profile(friend.id, "fkid", None, "unusable", 4).await.unwrap();
        assert_eq!(db.count_account_profiles(ben.id).await.unwrap(), 2);

        let names = |p: Vec<DeviceProfile>| p.into_iter().map(|p| p.username).collect::<Vec<_>>();
        let home_tv = db.create_device("a", "Living room", ben.id, 5).await.unwrap();
        assert_eq!(names(db.device_profiles(home_tv).await.unwrap()), ["ben", "kid"]);
        let friends_tv = db.create_device("b", "Friend's TV", friend.id, 6).await.unwrap();
        assert_eq!(names(db.device_profiles(friends_tv).await.unwrap()), ["friend", "fkid"]);

        // Deleting an owner deletes the account: its profiles and TVs go with it.
        db.delete_user(friend.id).await.unwrap();
        assert!(db.user(friends_kid.id).await.unwrap().is_none());
        assert!(db.device(friends_tv).await.unwrap().is_none());
        assert_eq!(names(db.device_profiles(home_tv).await.unwrap()), ["ben", "kid"]);

        db.add_favorite(kid.id, "title", "m1", 1).await.unwrap();
        db.add_favorite(kid.id, "series", "Bluey", 2).await.unwrap();
        db.add_favorite(kid.id, "series", "Bluey", 3).await.unwrap();
        let favs = db.favorites(kid.id).await.unwrap();
        assert_eq!(
            favs,
            [("series".to_string(), "Bluey".to_string()), ("title".to_string(), "m1".to_string())]
        );
        assert!(db.remove_favorite(kid.id, "title", "m1").await.unwrap());
        assert!(db.favorites(ben.id).await.unwrap().is_empty(), "lists are per profile");
    }
}
