//! Web Push: the web app's notifications ("Dune is ready to watch") when the browser isn't open
//! on Panda. The server signs with its own VAPID key (made once, kept encrypted as a secret);
//! each browser's subscription (endpoint + keys) is stored per profile; a message is encrypted
//! for each of the requester's browsers and posted to its browser's push service.
//!
//! Only the browsers' own push services are ever posted to (Google, Mozilla, Apple, Microsoft):
//! a subscription's endpoint comes from a client, and the server must not be made to call
//! anything else.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint as _;
use web_push_native::{Auth, WebPushBuilder};

use crate::error::{ApiError, ApiResult};
use crate::services::settings::{read_secret, write_secret};
use crate::state::AppState;

/// The setting holding the private VAPID key (base64url), encrypted.
const VAPID_KEY: &str = "web_push.vapid";
/// Who to contact about this sender, as push services ask (the software's page).
const CONTACT: &str = "https://github.com/mrkirchner/panda";

/// Push services browsers subscribe with: the only hosts (and their subdomains) posted to.
const PUSH_HOSTS: [&str; 4] =
    ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

/// Whether `endpoint` is a browser push service's https address.
pub(crate) fn allowed_endpoint(endpoint: &str) -> bool {
    let Ok(uri) = endpoint.parse::<http::Uri>() else { return false };
    if uri.scheme_str() != Some("https") {
        return false;
    }
    let Some(host) = uri.host() else { return false };
    PUSH_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// The server's VAPID key, made on first use.
async fn key_pair(state: &AppState) -> ApiResult<ES256KeyPair> {
    if let Some(stored) = read_secret(state, VAPID_KEY).await? {
        let bytes = URL_SAFE_NO_PAD.decode(stored.trim()).map_err(|e| ApiError::Internal(e.to_string()))?;
        return ES256KeyPair::from_bytes(&bytes).map_err(|e| ApiError::Internal(e.to_string()));
    }
    let kp = ES256KeyPair::generate();
    write_secret(state, VAPID_KEY, &URL_SAFE_NO_PAD.encode(kp.to_bytes())).await?;
    Ok(kp)
}

/// The public key browsers subscribe with (`applicationServerKey`), base64url.
pub(crate) async fn public_key(state: &AppState) -> ApiResult<String> {
    let kp = key_pair(state).await?;
    // Browsers take the uncompressed point (jwt-simple hands out the compressed one).
    let point = web_push_native::p256::PublicKey::from_sec1_bytes(&kp.public_key().to_bytes())
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .to_encoded_point(false);
    Ok(URL_SAFE_NO_PAD.encode(point.as_bytes()))
}

/// What the web app's service worker shows.
#[derive(Serialize)]
pub(crate) struct Message {
    pub title: String,
    pub body: String,
    /// The page to open when it's clicked ("/title/m927").
    pub open: Option<String>,
}

/// Tell every browser of `user_id`. Browsers that are gone (404/410) are forgotten; other
/// failures are logged and left for next time.
pub(crate) async fn send(state: &AppState, user_id: i64, message: &Message) -> anyhow::Result<()> {
    let subs = state.db.push_subscriptions(user_id).await?;
    if subs.is_empty() {
        return Ok(());
    }
    let kp = key_pair(state).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let body = serde_json::to_vec(message)?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?;
    for sub in subs {
        if !allowed_endpoint(&sub.endpoint) {
            continue;
        }
        let request = match build(&kp, &sub.endpoint, &sub.p256dh, &sub.auth, &body) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "a push subscription can't be used; forgetting it");
                state.db.delete_push_subscription(&sub.endpoint, None).await?;
                continue;
            }
        };
        let (parts, payload) = request.into_parts();
        let mut req = client.post(parts.uri.to_string()).body(payload);
        for (name, value) in &parts.headers {
            req = req.header(name.as_str(), value.as_bytes());
        }
        match req.send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) if matches!(r.status().as_u16(), 404 | 410) => {
                state.db.delete_push_subscription(&sub.endpoint, None).await?;
            }
            Ok(r) => tracing::warn!(status = %r.status(), "push service refused a message"),
            Err(e) => tracing::warn!(error = %e, "couldn't reach a push service"),
        }
    }
    Ok(())
}

fn build(
    kp: &ES256KeyPair,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    body: &[u8],
) -> anyhow::Result<http::Request<Vec<u8>>> {
    let public = web_push_native::p256::PublicKey::from_sec1_bytes(
        &URL_SAFE_NO_PAD.decode(p256dh.trim_end_matches('='))?,
    )?;
    let auth = URL_SAFE_NO_PAD.decode(auth.trim_end_matches('='))?;
    anyhow::ensure!(auth.len() == 16, "auth secret must be 16 bytes");
    Ok(WebPushBuilder::new(endpoint.parse()?, public, Auth::clone_from_slice(&auth))
        .with_vapid(kp, CONTACT)
        .build(body.to_vec())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_browser_push_services() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/QK1",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ] {
            assert!(allowed_endpoint(ok), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://evil.example/fcm.googleapis.com",
            "https://fcm.googleapis.com.evil.example/x",
            "https://192.168.1.1/",
            "https://localhost:8096/api/admin",
            "not a url",
        ] {
            assert!(!allowed_endpoint(bad), "{bad}");
        }
    }

    #[test]
    fn a_message_is_encrypted_for_a_browser() {
        // A browser's keys, made the way a browser makes them.
        let browser = web_push_native::p256::SecretKey::random(
            &mut web_push_native::p256::elliptic_curve::rand_core::OsRng,
        );
        let p256dh = URL_SAFE_NO_PAD.encode(browser.public_key().to_sec1_bytes());
        let auth = URL_SAFE_NO_PAD.encode([7u8; 16]);
        let kp = ES256KeyPair::generate();
        let req =
            build(&kp, "https://fcm.googleapis.com/fcm/send/x", &p256dh, &auth, b"{\"title\":\"Dune\"}")
                .unwrap();
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        assert!(req.headers()["authorization"].to_str().unwrap().starts_with("vapid t="));
        assert!(!req.body().windows(4).any(|w| w == b"Dune"), "the payload is encrypted");
        // And the browser, with its private key and auth secret, reads it back.
        let plain =
            web_push_native::decrypt(req.body().clone(), &browser, &Auth::clone_from_slice(&[7u8; 16]))
                .unwrap();
        assert_eq!(plain, b"{\"title\":\"Dune\"}");
    }
}
