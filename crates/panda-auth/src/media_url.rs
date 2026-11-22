//! Signed media URLs. Video elements, HLS segment fetches and image loaders can't send an
//! `Authorization` header, so those URLs carry `?t=<token>` instead.
//!
//! Token = `{user_id}.{gen}.{expires_unix}.{base64(scope)}.{base64(hmac)}`. It grants read
//! access to paths under `scope` (a prefix ending in `/`) until it expires. Being bound to a path
//! prefix means a leaked stream URL can't be reused for other media. `gen` is the user's token
//! generation: the server refuses tokens from an older one (bumped to revoke them all).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub struct MediaSigner {
    key: [u8; 32],
}

impl std::fmt::Debug for MediaSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaSigner(<redacted>)")
    }
}

impl MediaSigner {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    fn mac(&self, payload: &str) -> HmacSha256 {
        let mut mac =
            <HmacSha256 as KeyInit>::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(payload.as_bytes());
        mac
    }

    /// `scope` must end with `/` so `/api/items/1/` can't match `/api/items/12/...`.
    pub fn sign(&self, user_id: i64, generation: i64, scope: &str, expires_unix: u64) -> String {
        debug_assert!(scope.ends_with('/'), "scope must end with '/'");
        let payload = format!("{user_id}.{generation}.{expires_unix}.{}", URL_SAFE_NO_PAD.encode(scope));
        let sig = URL_SAFE_NO_PAD.encode(self.mac(&payload).finalize().into_bytes());
        format!("{payload}.{sig}")
    }

    /// The user id and token generation, if `token` is authentic, unexpired and covers `path`
    /// (the caller checks the generation is the user's current one).
    pub fn verify(&self, token: &str, path: &str, now_unix: u64) -> Option<(i64, i64)> {
        let (payload, sig) = token.rsplit_once('.')?;
        let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
        // Constant-time check before trusting anything in the payload.
        self.mac(payload).verify_slice(&sig).ok()?;

        let mut parts = payload.splitn(4, '.');
        let user_id: i64 = parts.next()?.parse().ok()?;
        let generation: i64 = parts.next()?.parse().ok()?;
        let expires: u64 = parts.next()?.parse().ok()?;
        let scope = String::from_utf8(URL_SAFE_NO_PAD.decode(parts.next()?).ok()?).ok()?;
        let in_scope = scope.ends_with('/') && path.starts_with(&scope) && !path.contains("/../");
        (expires >= now_unix && in_scope).then_some((user_id, generation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn valid_token_grants_only_its_scope() {
        let s = MediaSigner::new([3; 32]);
        let t = s.sign(42, 0, "/api/items/1/", NOW + 60);
        assert_eq!(s.verify(&t, "/api/items/1/stream", NOW), Some((42, 0)));
        assert_eq!(s.verify(&t, "/api/items/12/stream", NOW), None);
        assert_eq!(s.verify(&t, "/api/items/1/../2/stream", NOW), None);
        assert_eq!(s.verify(&t, "/api/admin/users", NOW), None);
    }

    #[test]
    fn expired_forged_or_foreign_tokens_fail() {
        let s = MediaSigner::new([3; 32]);
        let t = s.sign(42, 0, "/api/images/", NOW + 60);
        assert_eq!(s.verify(&t, "/api/images/a.jpg", NOW + 61), None, "expired");
        assert_eq!(MediaSigner::new([4; 32]).verify(&t, "/api/images/a.jpg", NOW), None, "other key");
        // Changing the user id or scope invalidates the signature.
        let forged = t.replacen("42.", "1.", 1);
        assert_eq!(
            s.verify(&t.replacen("42.0.", "42.1.", 1), "/api/images/a.jpg", NOW),
            None,
            "generation is signed"
        );
        assert_eq!(s.verify(&forged, "/api/images/a.jpg", NOW), None);
        assert_eq!(s.verify("garbage", "/api/images/a.jpg", NOW), None);
        assert_eq!(s.verify("", "/", NOW), None);
    }
}
