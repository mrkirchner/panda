//! Opaque bearer secrets. The plaintext goes to the client once, and only [`digest`] is stored,
//! so a leaked database can't be replayed as credentials.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Result, random_bytes};

/// 256 random bits, URL-safe base64 (43 chars).
pub fn generate() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

/// Hex SHA-256. Fine for high-entropy tokens (unlike passwords, they can't be brute-forced).
pub fn digest(token: &str) -> String {
    use std::fmt::Write;
    Sha256::digest(token.as_bytes()).iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

pub fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Unambiguous alphabet for codes people type on a phone (no 0/O, 1/I/L, vowels).
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKMNPQRSTVWXZ23456789";

/// Device-pairing code like `K7QM-4PBX`: 8 chars of a 27-symbol alphabet (~38 bits). It's
/// short-lived and rate-limited, and approving it still requires a signed-in user.
pub fn user_code() -> Result<String> {
    let bytes = random_bytes::<8>()?;
    let n = USER_CODE_ALPHABET.len();
    let chars: String = bytes.iter().map(|b| USER_CODE_ALPHABET[usize::from(*b) % n] as char).collect();
    Ok(format!("{}-{}", &chars[..4], &chars[4..]))
}

/// Normalize what a person typed: case-insensitive, dashes/spaces optional.
pub fn normalize_user_code(input: &str) -> String {
    let c: String =
        input.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect();
    if c.len() == 8 { format!("{}-{}", &c[..4], &c[4..]) } else { c }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_digests_stable() {
        let (a, b) = (generate().unwrap(), generate().unwrap());
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert_eq!(digest(&a), digest(&a));
        assert_ne!(digest(&a), digest(&b));
        assert_eq!(digest(&a).len(), 64);
    }

    #[test]
    fn user_codes_are_typeable() {
        let code = user_code().unwrap();
        assert_eq!(code.len(), 9);
        assert!(code.chars().all(|c| c == '-' || USER_CODE_ALPHABET.contains(&(c as u8))));
        assert_eq!(normalize_user_code("k7qm 4pbx"), "K7QM-4PBX");
        assert_eq!(normalize_user_code("K7QM-4PBX"), "K7QM-4PBX");
    }

    #[test]
    fn constant_time_compare() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
    }
}
