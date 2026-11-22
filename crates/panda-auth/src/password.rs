//! Argon2id password hashing (OWASP-recommended). Hashing is deliberately slow (~50-100 ms),
//! so async callers must run these functions on a blocking thread.

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};

use crate::{Error, Result};

/// NIST SP 800-63B: length matters, composition rules don't. Allow long passphrases, cap
/// the length so a huge input can't be used to burn CPU.
pub const MIN_LEN: usize = 10;
pub const MAX_LEN: usize = 256;

pub fn check_policy(password: &str) -> Result<()> {
    let len = password.chars().count();
    if (MIN_LEN..=MAX_LEN).contains(&len) { Ok(()) } else { Err(Error::PasswordPolicy) }
}

/// Hash with a fresh random salt. Returns a PHC string (`$argon2id$v=19$m=...`).
pub fn hash(password: &str) -> Result<String> {
    check_policy(password)?;
    Argon2::default().hash_password(password.as_bytes()).map(|h| h.to_string()).map_err(|_| Error::Hash)
}

/// Constant-time verification. Parameters are read from the stored hash, so hashes made
/// with older settings keep working after defaults change.
pub fn verify(password: &str, phc: &str) -> bool {
    if password.len() > MAX_LEN * 4 {
        return false;
    }
    PasswordHash::new(phc)
        .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

/// Profile PINs for shared TVs: 4-8 digits, hashed with Argon2id like passwords. They are low
/// entropy, so the server must rate-limit attempts; the slow hash still protects a leaked DB.
pub fn hash_pin(pin: &str) -> Result<String> {
    let ok = (4..=8).contains(&pin.len()) && pin.chars().all(|c| c.is_ascii_digit());
    if !ok {
        return Err(Error::PinPolicy);
    }
    Argon2::default().hash_password(pin.as_bytes()).map(|h| h.to_string()).map_err(|_| Error::Hash)
}

/// A valid hash of an unguessable value. Verifying against it when a username doesn't exist
/// makes "no such user" take as long as "wrong password", so timing doesn't reveal accounts.
pub fn dummy_hash() -> &'static str {
    use std::sync::OnceLock;
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        let random = crate::token::generate().unwrap_or_else(|_| "panda-dummy-password-fallback".into());
        hash(&random).unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_argon2id_salted_and_verifiable() {
        let a = hash("correct horse battery").unwrap();
        let b = hash("correct horse battery").unwrap();
        assert!(a.starts_with("$argon2id$"));
        assert_ne!(a, b, "each hash must use a fresh salt");
        assert!(!a.contains("correct horse"), "plaintext must never appear in the hash");
        assert!(verify("correct horse battery", &a));
        assert!(!verify("correct horse batterY", &a));
        assert!(!verify("anything", "not a phc string"));
    }

    #[test]
    fn enforces_length_policy() {
        assert!(matches!(hash("short"), Err(Error::PasswordPolicy)));
        assert!(matches!(hash(&"x".repeat(MAX_LEN + 1)), Err(Error::PasswordPolicy)));
        assert!(check_policy("ten chars!").is_ok());
    }

    #[test]
    fn pins() {
        let h = hash_pin("4821").unwrap();
        assert!(h.starts_with("$argon2id$") && !h.contains("4821"));
        assert!(verify("4821", &h));
        assert!(!verify("4822", &h));
        for bad in ["123", "123456789", "12a4", ""] {
            assert!(matches!(hash_pin(bad), Err(Error::PinPolicy)), "{bad}");
        }
    }

    #[test]
    fn dummy_hash_never_matches_user_input() {
        assert!(dummy_hash().starts_with("$argon2id$"));
        assert!(!verify("", dummy_hash()));
        assert!(!verify("password123", dummy_hash()));
    }
}
