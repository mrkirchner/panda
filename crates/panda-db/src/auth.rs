//! Users, sessions, invites, device codes. This module only stores hashes: callers hash
//! passwords (Argon2id) and tokens (SHA-256) with `panda-auth` before calling in.

use serde::{Deserialize, Serialize};

use crate::{Db, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Role {
    Admin,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SessionKind {
    Browser,
    Device,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: Role,
    pub disabled: bool,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
    /// The account this profile belongs to: its owner's id (the owner's own id for the owner,
    /// the account's primary profile). TVs list the profiles of their account.
    pub account_id: i64,
    /// Profile without a password (made on a TV or by an admin): TV-only, can't sign in.
    pub managed: bool,
    /// Shown instead of the username when set.
    pub display_name: Option<String>,
    /// App language (`en`, `es`); `None` follows the device.
    pub language: Option<String>,
    /// Avatar picture id from the bundled set; `None` is the colored initial.
    pub avatar: Option<String>,
    /// Signs in with this or the username (with a password).
    pub email: Option<String>,
    /// Home preview clips play (quietly) with sound.
    pub preview_sound: bool,
    /// In every signed URL; bumped to revoke them all (password change, sign out everywhere).
    #[serde(skip)]
    pub token_gen: i64,
    /// The oldest age rating this profile may watch (`None`: no limit). Titles without a
    /// rating are hidden from a limited profile.
    pub max_age: Option<i64>,
}

/// Only for verifying a login. Never serialized.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Credentials {
    pub id: i64,
    pub password_hash: String,
    pub disabled: bool,
    /// Managed profiles have no password; logins are always refused.
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Session {
    pub id: i64,
    pub user_id: i64,
    pub kind: SessionKind,
    pub name: Option<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Invite {
    pub id: i64,
    pub role: Role,
    pub note: Option<String>,
    pub created_by: Option<i64>,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_by: Option<i64>,
    pub used_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum DevicePoll {
    /// Not approved yet. Keep polling.
    Pending,
    /// Approved. The code has been consumed; create a session for this user.
    Approved {
        user_id: i64,
        device_name: String,
        /// Set when an already-paired device asked to add a profile.
        device_id: Option<i64>,
    },
    /// Unknown or expired code. Start over.
    Invalid,
}

macro_rules! user_columns {
    () => {
        "id, username, role, disabled, created_at, last_login_at, account_id, managed, display_name, language, avatar, email, preview_sound, token_gen, max_age"
    };
}

impl Db {
    /// Every profile of the account `account_id` owns (the owner first).
    pub async fn account_profiles(&self, account_id: i64) -> Result<Vec<User>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            user_columns!(),
            " FROM users WHERE account_id = ? ORDER BY id != account_id, id"
        ))
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?)
    }
}

/// Last-seen updates are written at most this often per session (avoids a write per request).
const TOUCH_INTERVAL_SECS: i64 = 300;

impl Db {
    pub async fn count_users(&self) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&self.pool).await?;
        Ok(n)
    }

    /// Create the first admin, but only while no users exist (safe against two setup requests racing).
    pub async fn create_first_admin(
        &self,
        username: &str,
        password_hash: &str,
        now: i64,
    ) -> Result<Option<User>> {
        let mut tx = self.pool.begin().await?;
        let id: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO users (username, password_hash, role, created_at)
             SELECT ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)
             RETURNING id",
        )
        .bind(username)
        .bind(password_hash)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((id,)) = id else { return Ok(None) };
        let user = own_account(&mut tx, id).await?;
        tx.commit().await?;
        Ok(Some(user))
    }

    pub async fn credentials(&self, username: &str) -> Result<Option<Credentials>> {
        // The username or the email address.
        Ok(sqlx::query_as(
            "SELECT u.id, u.password_hash, u.managed,
                    u.disabled OR EXISTS (SELECT 1 FROM users o WHERE o.id = u.account_id AND o.disabled = 1) AS disabled
             FROM users u WHERE u.username = ?1 OR u.email = ?1",
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Update a profile's own settings. `None` leaves a field as it is; `Some(None)` resets it.
    pub async fn update_profile(
        &self,
        id: i64,
        display_name: Option<Option<&str>>,
        language: Option<Option<&str>>,
        avatar: Option<Option<&str>>,
        preview_sound: Option<bool>,
    ) -> Result<()> {
        if let Some(v) = display_name {
            sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
                .bind(v)
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(v) = language {
            sqlx::query("UPDATE users SET language = ? WHERE id = ?")
                .bind(v)
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(v) = avatar {
            sqlx::query("UPDATE users SET avatar = ? WHERE id = ?")
                .bind(v)
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(v) = preview_sound {
            sqlx::query("UPDATE users SET preview_sound = ? WHERE id = ?")
                .bind(v)
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// A profile, `disabled` when it or its account's owner is: disabling an owner shuts the
    /// whole account (its profiles, TVs and signed URLs), and enabling it restores them.
    pub async fn user(&self, id: i64) -> Result<Option<User>> {
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            user_columns!(),
            " FROM (SELECT u.id, u.username, u.role,
                           u.disabled OR EXISTS (SELECT 1 FROM users o WHERE o.id = u.account_id AND o.disabled = 1) AS disabled,
                           u.created_at, u.last_login_at, u.account_id, u.managed, u.display_name, u.language,
                           u.avatar, u.email, u.preview_sound, u.token_gen, u.max_age
                    FROM users u WHERE u.id = ?)"
        ))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn users(&self) -> Result<Vec<User>> {
        Ok(sqlx::query_as(concat!("SELECT ", user_columns!(), " FROM users ORDER BY username"))
            .fetch_all(&self.pool)
            .await?)
    }

    pub async fn record_login(&self, user_id: i64, now: i64) -> Result<()> {
        sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
            .bind(now)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Also turns a family profile into a normal account that can sign in.
    pub async fn set_password(&self, user_id: i64, password_hash: &str) -> Result<()> {
        // A new password also revokes every URL signed before it.
        sqlx::query(
            "UPDATE users SET password_hash = ?, managed = 0, token_gen = token_gen + 1 WHERE id = ?",
        )
        .bind(password_hash)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Disabling a user also signs them out everywhere.
    pub async fn set_user_disabled(&self, user_id: i64, disabled: bool) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE users SET disabled = ? WHERE id = ?")
            .bind(disabled)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        if disabled {
            sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(user_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE users SET token_gen = token_gen + 1 WHERE id = ?")
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// A profile with no password in an account (e.g. a child), used on that account's TVs.
    /// `unusable_hash` must be the hash of a random secret that was thrown away.
    pub async fn create_managed_profile(
        &self,
        account_id: i64,
        username: &str,
        display_name: Option<&str>,
        unusable_hash: &str,
        now: i64,
    ) -> Result<User> {
        Ok(sqlx::query_as(concat!(
            "INSERT INTO users (username, password_hash, role, created_at, account_id, managed, display_name)
             VALUES (?, ?, 'user', ?, ?, 1, ?) RETURNING ",
            user_columns!()
        ))
        .bind(username)
        .bind(unusable_hash)
        .bind(now)
        .bind(account_id)
        .bind(display_name)
        .fetch_one(&self.pool)
        .await?)
    }

    /// A one-time link for a profile to set its own sign-in (replaces any earlier one).
    pub async fn create_sign_in_link(
        &self,
        user_id: i64,
        email: &str,
        token_hash: &str,
        now: i64,
        expires_at: i64,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM sign_in_links WHERE user_id = ?").bind(user_id).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO sign_in_links (token_hash, user_id, email, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(token_hash)
        .bind(user_id)
        .bind(email)
        .bind(now)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The profile a sign-in link is for and the email it was sent to, while it's unused and
    /// unexpired.
    pub async fn sign_in_link(&self, token_hash: &str, now: i64) -> Result<Option<(User, String)>> {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT user_id, email FROM sign_in_links WHERE token_hash = ? AND expires_at > ?",
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        let Some((id, email)) = row else { return Ok(None) };
        Ok(self.user(id).await?.map(|u| (u, email)))
    }

    /// Use a sign-in link: the profile takes the link's email and this password (it can sign in
    /// from now on) and the link goes. `None` when the link is invalid; a taken email is a
    /// unique violation.
    pub async fn use_sign_in_link(
        &self,
        token_hash: &str,
        password_hash: &str,
        now: i64,
    ) -> Result<Option<i64>> {
        let mut tx = self.pool.begin().await?;
        let row: Option<(i64, String)> = sqlx::query_as(
            "DELETE FROM sign_in_links WHERE token_hash = ? AND expires_at > ? RETURNING user_id, email",
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((id, email)) = row else { return Ok(None) };
        sqlx::query("UPDATE users SET email = ?, password_hash = ?, managed = 0 WHERE id = ?")
            .bind(email)
            .bind(password_hash)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(id))
    }

    /// Turn a profile's own sign-in off: no email, an unusable password (`unusable_hash`), and
    /// every session it has ends except `keep` (the device turning it off).
    pub async fn remove_sign_in(&self, user_id: i64, unusable_hash: &str, keep: Option<i64>) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE users SET email = NULL, password_hash = ?, managed = 1, token_gen = token_gen + 1 WHERE id = ?",
        )
            .bind(unusable_hash)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM sign_in_links WHERE user_id = ?").bind(user_id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?")
            .bind(user_id)
            .bind(keep)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Profiles in an account (owner included).
    pub async fn count_account_profiles(&self, account_id: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE account_id = ?")
            .bind(account_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(n)
    }

    /// Active admins outside an account (deleting an account must leave one).
    pub async fn count_active_admins_outside(&self, account_id: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND account_id != ?",
        )
        .bind(account_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    pub async fn set_user_role(&self, user_id: i64, role: Role) -> Result<()> {
        sqlx::query("UPDATE users SET role = ? WHERE id = ?")
            .bind(role)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_user(&self, user_id: i64) -> Result<()> {
        sqlx::query("DELETE FROM users WHERE id = ?").bind(user_id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn count_active_admins(&self) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0")
            .fetch_one(&self.pool)
            .await?;
        Ok(n)
    }

    // ---- sessions ----

    pub async fn create_session(
        &self,
        user_id: i64,
        token_hash: &str,
        kind: SessionKind,
        name: Option<&str>,
        now: i64,
        expires_at: i64,
    ) -> Result<i64> {
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO sessions (token_hash, user_id, kind, name, created_at, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(token_hash)
        .bind(user_id)
        .bind(kind)
        .bind(name)
        .bind(now)
        .bind(now)
        .bind(expires_at)
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    /// Resolve a session token to its (enabled) user. Device sessions slide their expiry
    /// forward by `extend_secs` when used.
    pub async fn session_user(
        &self,
        token_hash: &str,
        now: i64,
        extend_secs: i64,
    ) -> Result<Option<(Session, User)>> {
        let session: Option<Session> = sqlx::query_as(
            "SELECT s.id, s.user_id, s.kind, s.name, s.created_at, s.last_seen_at, s.expires_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
               AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = u.account_id AND o.disabled = 1)",
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        let Some(mut session) = session else { return Ok(None) };
        let Some(user) = self.user(session.user_id).await? else { return Ok(None) };

        let (id, kind, expires_at) = (session.id, session.kind, session.expires_at);
        if now - session.last_seen_at > TOUCH_INTERVAL_SECS {
            let new_expiry =
                if kind == SessionKind::Device { (now + extend_secs).max(expires_at) } else { expires_at };
            sqlx::query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
                .bind(now)
                .bind(new_expiry)
                .bind(id)
                .execute(&self.pool)
                .await?;
            session.last_seen_at = now;
            session.expires_at = new_expiry;
        }
        Ok(Some((session, user)))
    }

    pub async fn delete_session_by_hash(&self, token_hash: &str) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(token_hash).execute(&self.pool).await?;
        Ok(())
    }

    /// Revoke one session. `user_id` limits it to that user's own sessions (None = admin).
    pub async fn delete_session(&self, id: i64, user_id: Option<i64>) -> Result<bool> {
        let res = match user_id {
            Some(uid) => sqlx::query("DELETE FROM sessions WHERE id = ? AND user_id = ?").bind(id).bind(uid),
            None => sqlx::query("DELETE FROM sessions WHERE id = ?").bind(id),
        }
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Sign a user out everywhere except (optionally) one session, e.g. after a password change.
    pub async fn delete_user_sessions(&self, user_id: i64, except_session: Option<i64>) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE user_id = ? AND id != ?")
            .bind(user_id)
            .bind(except_session.unwrap_or(-1))
            .execute(&self.pool)
            .await?;
        // And the signed URLs handed out to those sessions.
        sqlx::query("UPDATE users SET token_gen = token_gen + 1 WHERE id = ?")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn sessions(&self, user_id: Option<i64>) -> Result<Vec<Session>> {
        Ok(match user_id {
            Some(uid) => {
                sqlx::query_as(
                    "SELECT id, user_id, kind, name, created_at, last_seen_at, expires_at FROM sessions
                     WHERE user_id = ? ORDER BY last_seen_at DESC",
                )
                .bind(uid)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT id, user_id, kind, name, created_at, last_seen_at, expires_at FROM sessions
                     ORDER BY last_seen_at DESC",
                )
                .fetch_all(&self.pool)
                .await?
            }
        })
    }

    // ---- invites ----

    #[allow(clippy::too_many_arguments)] // Mirrors the invites row; every field is required.
    pub async fn create_invite(
        &self,
        token_hash: &str,
        role: Role,
        note: Option<&str>,
        created_by: i64,
        now: i64,
        expires_at: i64,
    ) -> Result<Invite> {
        Ok(sqlx::query_as(
            "INSERT INTO invites (token_hash, role, note, created_by, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id, role, note, created_by, created_at, expires_at, used_by, used_at",
        )
        .bind(token_hash)
        .bind(role)
        .bind(note)
        .bind(created_by)
        .bind(now)
        .bind(expires_at)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn invites(&self) -> Result<Vec<Invite>> {
        Ok(sqlx::query_as(
            "SELECT id, role, note, created_by, created_at, expires_at, used_by, used_at
             FROM invites ORDER BY created_at DESC",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn delete_invite(&self, id: i64) -> Result<bool> {
        Ok(sqlx::query("DELETE FROM invites WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }

    /// Is this invite usable right now? (Checked before the slow password hash.)
    pub async fn invite_valid(&self, token_hash: &str, now: i64) -> Result<bool> {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    /// Atomically consume an unused, unexpired invite and create the account it grants (the
    /// invited person owns it).
    /// Returns `None` if the invite is invalid. A taken username surfaces as a unique violation.
    pub async fn accept_invite(
        &self,
        token_hash: &str,
        username: &str,
        password_hash: &str,
        now: i64,
    ) -> Result<Option<User>> {
        let mut tx = self.pool.begin().await?;
        let invite: Option<(i64, Role)> = sqlx::query_as(
            "UPDATE invites SET used_at = ?
             WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
             RETURNING id, role",
        )
        .bind(now)
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((invite_id, role)) = invite else { return Ok(None) };
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .bind(username)
        .bind(password_hash)
        .bind(role)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        let user = own_account(&mut tx, id).await?;
        sqlx::query("UPDATE invites SET used_by = ? WHERE id = ?")
            .bind(user.id)
            .bind(invite_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(user))
    }

    // ---- device codes ----

    pub async fn create_device_code(
        &self,
        device_code_hash: &str,
        user_code: &str,
        device_name: &str,
        device_id: Option<i64>,
        now: i64,
        expires_at: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO device_codes (device_code_hash, user_code, device_name, device_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(device_code_hash)
        .bind(user_code)
        .bind(device_name)
        .bind(device_id)
        .bind(now)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn approve_device_code(
        &self,
        user_code: &str,
        user_id: i64,
        now: i64,
    ) -> Result<Option<String>> {
        let row: Option<(String,)> = sqlx::query_as(
            "UPDATE device_codes SET approved_by = ?, approved_at = ?
             WHERE user_code = ? AND expires_at > ? AND approved_by IS NULL
             RETURNING device_name",
        )
        .bind(user_id)
        .bind(now)
        .bind(user_code)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// Poll by the device. An approved code is deleted as it's returned (single use).
    pub async fn poll_device_code(&self, device_code_hash: &str, now: i64) -> Result<DevicePoll> {
        let approved: Option<(i64, String, Option<i64>)> = sqlx::query_as(
            "DELETE FROM device_codes
             WHERE device_code_hash = ? AND approved_by IS NOT NULL AND expires_at > ?
             RETURNING approved_by, device_name, device_id",
        )
        .bind(device_code_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        if let Some((user_id, device_name, device_id)) = approved {
            return Ok(DevicePoll::Approved { user_id, device_name, device_id });
        }
        let pending: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM device_codes WHERE device_code_hash = ? AND expires_at > ?")
                .bind(device_code_hash)
                .bind(now)
                .fetch_optional(&self.pool)
                .await?;
        Ok(if pending.is_some() { DevicePoll::Pending } else { DevicePoll::Invalid })
    }

    /// Remove expired sessions, device codes and unused invites.
    pub async fn purge_expired(&self, now: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM sessions WHERE expires_at <= ?").bind(now).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM device_codes WHERE expires_at <= ?").bind(now).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ---- library access ----

    /// Libraries a profile may see: its account's (set on the owner). `None` = all (admins, or
    /// accounts with no restriction rows).
    pub async fn allowed_libraries(&self, user: &User) -> Result<Option<Vec<i64>>> {
        if user.role == Role::Admin {
            return Ok(None);
        }
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT library_id FROM user_libraries WHERE user_id = ?")
            .bind(user.account_id)
            .fetch_all(&self.pool)
            .await?;
        Ok((!rows.is_empty()).then(|| rows.into_iter().map(|r| r.0).collect()))
    }

    pub async fn set_user_libraries(&self, user_id: i64, library_ids: &[i64]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM user_libraries WHERE user_id = ?").bind(user_id).execute(&mut *tx).await?;
        for lib in library_ids {
            sqlx::query("INSERT INTO user_libraries (user_id, library_id) VALUES (?, ?)")
                .bind(user_id)
                .bind(lib)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

/// Make a just-inserted user the owner of its own account, returning it.
async fn own_account(tx: &mut sqlx::SqliteConnection, id: i64) -> Result<User> {
    Ok(sqlx::query_as(concat!("UPDATE users SET account_id = id WHERE id = ? RETURNING ", user_columns!()))
        .bind(id)
        .fetch_one(tx)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[tokio::test]
    async fn first_admin_only_once() {
        let db = Db::in_memory().await.unwrap();
        assert!(db.create_first_admin("ben", "$argon2id$x", NOW).await.unwrap().is_some());
        assert!(db.create_first_admin("mallory", "$argon2id$y", NOW).await.unwrap().is_none());
        assert_eq!(db.count_users().await.unwrap(), 1);
        // Usernames are case-insensitive.
        assert_eq!(db.credentials("BEN").await.unwrap().unwrap().id, 1);
    }

    #[tokio::test]
    async fn sessions_expire_and_die_with_disabled_users() {
        let db = Db::in_memory().await.unwrap();
        let admin = db.create_first_admin("ben", "h", NOW).await.unwrap().unwrap();
        db.create_session(admin.id, "hash-a", SessionKind::Browser, None, NOW, NOW + 100).await.unwrap();
        assert!(db.session_user("hash-a", NOW + 50, 0).await.unwrap().is_some());
        assert!(db.session_user("hash-a", NOW + 101, 0).await.unwrap().is_none(), "expired");
        assert!(db.session_user("wrong", NOW, 0).await.unwrap().is_none());

        db.create_session(admin.id, "hash-b", SessionKind::Device, Some("TV"), NOW, NOW + 100).await.unwrap();
        db.set_user_disabled(admin.id, true).await.unwrap();
        assert!(db.session_user("hash-b", NOW, 0).await.unwrap().is_none(), "disabled user signed out");
        assert!(db.sessions(None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn device_sessions_slide_forward() {
        let db = Db::in_memory().await.unwrap();
        let u = db.create_first_admin("ben", "h", NOW).await.unwrap().unwrap();
        db.create_session(u.id, "d", SessionKind::Device, Some("TV"), NOW, NOW + 1000).await.unwrap();
        let (s, _) = db.session_user("d", NOW + 900, 10_000).await.unwrap().unwrap();
        assert_eq!(s.expires_at, NOW + 900 + 10_000);
    }

    #[tokio::test]
    async fn invites_are_single_use_and_expire() {
        let db = Db::in_memory().await.unwrap();
        let admin = db.create_first_admin("ben", "h", NOW).await.unwrap().unwrap();
        db.create_invite("inv", Role::User, Some("for sam"), admin.id, NOW, NOW + 60).await.unwrap();
        assert!(db.invite_valid("inv", NOW).await.unwrap());
        let sam = db.accept_invite("inv", "sam", "h2", NOW + 1).await.unwrap().unwrap();
        assert_eq!(sam.role, Role::User);
        assert!(db.accept_invite("inv", "sam2", "h3", NOW + 2).await.unwrap().is_none(), "already used");

        db.create_invite("old", Role::User, None, admin.id, NOW, NOW + 60).await.unwrap();
        assert!(db.accept_invite("old", "late", "h", NOW + 61).await.unwrap().is_none(), "expired");
        assert_eq!(db.count_users().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn device_code_flow() {
        let db = Db::in_memory().await.unwrap();
        let u = db.create_first_admin("ben", "h", NOW).await.unwrap().unwrap();
        db.create_device_code("dc", "K7QM-4PBX", "Living room TV", None, NOW, NOW + 600).await.unwrap();
        assert!(matches!(db.poll_device_code("dc", NOW).await.unwrap(), DevicePoll::Pending));
        assert_eq!(
            db.approve_device_code("K7QM-4PBX", u.id, NOW).await.unwrap().as_deref(),
            Some("Living room TV")
        );
        assert!(db.approve_device_code("K7QM-4PBX", u.id, NOW).await.unwrap().is_none(), "approve once");
        assert!(matches!(
            db.poll_device_code("dc", NOW).await.unwrap(),
            DevicePoll::Approved { user_id: 1, .. }
        ));
        assert!(matches!(db.poll_device_code("dc", NOW).await.unwrap(), DevicePoll::Invalid), "single use");
    }
}
