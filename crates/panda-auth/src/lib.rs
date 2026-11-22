//! Security primitives for Panda. No HTTP or database code lives here.
//!
//! Rules this crate enforces:
//! - Passwords are only ever stored as Argon2id PHC strings ([`password`]).
//! - Bearer secrets (sessions, device tokens, invites) are random 256-bit values, and only
//!   their SHA-256 digest is stored ([`token`]).
//! - Secrets Panda must reuse (TMDB token, Sonarr/Radarr keys) are encrypted at rest with
//!   XChaCha20-Poly1305 under a key file that never enters the database ([`secret_box`]).
//! - Media URLs that players fetch without headers carry short-lived HMAC signatures
//!   ([`media_url`]).
//! - Every secret comparison is constant-time.

pub mod media_url;
pub mod password;
pub mod secret_box;
pub mod token;

pub use media_url::MediaSigner;
pub use secret_box::SecretBox;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("password must be between {min} and {max} characters", min = password::MIN_LEN, max = password::MAX_LEN)]
    PasswordPolicy,
    #[error("PIN must be 4 to 8 digits")]
    PinPolicy,
    #[error("password hashing failed")]
    Hash,
    #[error("system random number generator failed")]
    Random,
    #[error("secret could not be decrypted (wrong key file or corrupted value)")]
    Decrypt,
    #[error("secret key file {0} is invalid")]
    BadKeyFile(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|_| Error::Random)?;
    Ok(buf)
}
