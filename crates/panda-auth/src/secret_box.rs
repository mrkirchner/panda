//! Encryption at rest for secrets Panda has to send to other services (TMDB token,
//! Sonarr/Radarr API keys). Those can't be hashed like passwords, so they're encrypted with
//! XChaCha20-Poly1305 under a 256-bit key kept in its own file (mode 0600), never in the DB.
//! A leaked database or backup alone reveals nothing.

use std::fs;
use std::io::Write;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::{Error, Result, random_bytes};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const VERSION: &str = "v1.";

pub struct SecretBox {
    key: [u8; KEY_LEN],
}

impl std::fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretBox(<redacted>)")
    }
}

impl SecretBox {
    /// Load the key file, creating it (mode 0600) on first run.
    pub fn load_or_create(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => {
                let key: [u8; KEY_LEN] =
                    bytes.try_into().map_err(|_| Error::BadKeyFile(path.display().to_string()))?;
                restrict_permissions(path)?;
                Ok(Self { key })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = random_bytes::<KEY_LEN>()?;
                if let Some(dir) = path.parent() {
                    fs::create_dir_all(dir)?;
                }
                let mut opts = fs::OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
                let mut f = opts.open(path)?;
                f.write_all(&key)?;
                f.sync_all()?;
                Ok(Self { key })
            }
            Err(e) => Err(e.into()),
        }
    }

    #[cfg(test)]
    fn from_key(key: [u8; KEY_LEN]) -> Self {
        Self { key }
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&self.key.into())
    }

    /// Encrypt `plaintext`. `context` (e.g. the setting name) is authenticated but not stored,
    /// so a ciphertext copied into a different setting fails to decrypt.
    pub fn encrypt(&self, plaintext: &str, context: &str) -> Result<String> {
        let nonce_bytes = random_bytes::<NONCE_LEN>()?;
        let nonce = XNonce::from(nonce_bytes);
        let ct = self
            .cipher()
            .encrypt(&nonce, Payload { msg: plaintext.as_bytes(), aad: context.as_bytes() })
            .map_err(|_| Error::Decrypt)?;
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(format!("{VERSION}{}", URL_SAFE_NO_PAD.encode(out)))
    }

    pub fn decrypt(&self, value: &str, context: &str) -> Result<String> {
        let raw = value.strip_prefix(VERSION).ok_or(Error::Decrypt)?;
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| Error::Decrypt)?;
        if bytes.len() <= NONCE_LEN {
            return Err(Error::Decrypt);
        }
        let (nonce, ct) = bytes.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| Error::Decrypt)?;
        let pt = self
            .cipher()
            .decrypt(&XNonce::from(nonce), Payload { msg: ct, aad: context.as_bytes() })
            .map_err(|_| Error::Decrypt)?;
        String::from_utf8(pt).map_err(|_| Error::Decrypt)
    }

    /// Independent sub-key for another purpose (e.g. media URL signing), so one key file
    /// serves everything without reusing key material across algorithms.
    pub fn derive_key(&self, label: &str) -> [u8; 32] {
        let mut mac =
            <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(label.as_bytes());
        mac.finalize().into_bytes().into()
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_context_binding() {
        let b = SecretBox::from_key([7; KEY_LEN]);
        let ct = b.encrypt("eyJhbGciOi-secret", "tmdb.token").unwrap();
        assert!(ct.starts_with("v1.") && !ct.contains("secret"));
        assert_eq!(b.decrypt(&ct, "tmdb.token").unwrap(), "eyJhbGciOi-secret");
        // Same plaintext encrypts differently every time (random nonce).
        assert_ne!(ct, b.encrypt("eyJhbGciOi-secret", "tmdb.token").unwrap());
        // Wrong context, wrong key or tampering all fail.
        assert!(b.decrypt(&ct, "radarr.api_key").is_err());
        assert!(SecretBox::from_key([8; KEY_LEN]).decrypt(&ct, "tmdb.token").is_err());
        let mut tampered = ct.clone();
        tampered.pop();
        tampered.push(if ct.ends_with('A') { 'B' } else { 'A' });
        assert!(b.decrypt(&tampered, "tmdb.token").is_err());
    }

    #[test]
    fn key_file_is_created_private_and_reloaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        let a = SecretBox::load_or_create(&path).unwrap();
        let ct = a.encrypt("x", "c").unwrap();
        let b = SecretBox::load_or_create(&path).unwrap();
        assert_eq!(b.decrypt(&ct, "c").unwrap(), "x");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::write(&path, b"short").unwrap();
        assert!(matches!(SecretBox::load_or_create(&path), Err(Error::BadKeyFile(_))));
    }

    #[test]
    fn derived_keys_differ_by_label() {
        let b = SecretBox::from_key([1; KEY_LEN]);
        assert_ne!(b.derive_key("media-url-v1"), b.derive_key("other"));
        assert_eq!(b.derive_key("media-url-v1"), b.derive_key("media-url-v1"));
    }

    #[test]
    fn debug_never_prints_key() {
        assert_eq!(format!("{:?}", SecretBox::from_key([9; KEY_LEN])), "SecretBox(<redacted>)");
    }
}
