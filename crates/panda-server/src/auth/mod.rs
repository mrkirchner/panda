//! Request authentication: sessions (cookie for browsers, bearer token for devices) and
//! signed media URLs. See `panda-auth` for the primitives.

pub(crate) mod limiter;
pub(crate) mod middleware;

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use panda_auth::token;
use panda_db::{Role, SessionKind, User};

use crate::error::ApiResult;
use crate::services::settings::now;
use crate::state::AppState;

pub(crate) const SESSION_COOKIE: &str = "panda_session";
/// Browser sessions: absolute lifetime.
pub(crate) const BROWSER_SESSION_SECS: i64 = 30 * 24 * 3600;
/// Device (TV) sessions: sliding lifetime, renewed while the device is used.
pub(crate) const DEVICE_SESSION_SECS: i64 = 180 * 24 * 3600;
/// Stream/segment/subtitle URL lifetime.
pub(crate) const MEDIA_TOKEN_SECS: u64 = 12 * 3600;
const WEEK_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthVia {
    Cookie,
    Bearer,
}

/// The signed-in user, inserted into request extensions by the auth middleware.
#[derive(Debug, Clone)]
pub(crate) struct CurrentUser {
    pub user: User,
    pub session_id: i64,
    pub via: AuthVia,
}

impl CurrentUser {
    pub(crate) fn is_admin(&self) -> bool {
        self.user.role == Role::Admin
    }
}

/// Resolve the session from `Authorization: Bearer` or the session cookie.
pub(crate) async fn authenticate(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<CurrentUser>> {
    let (raw, via) = if let Some(t) = bearer(headers) {
        (t, AuthVia::Bearer)
    } else if let Some(c) = cookie(headers, SESSION_COOKIE) {
        (c, AuthVia::Cookie)
    } else {
        return Ok(None);
    };
    let hash = token::digest(&raw);
    Ok(state.db.session_user(&hash, now(), DEVICE_SESSION_SECS).await?.map(|(session, user)| CurrentUser {
        user,
        session_id: session.id,
        via,
    }))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let t = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))?.trim();
    (!t.is_empty()).then(|| t.to_string())
}

pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

/// Create a session and return its plaintext token (shown to the client exactly once).
pub(crate) async fn start_session(
    state: &AppState,
    user_id: i64,
    kind: SessionKind,
    name: Option<&str>,
) -> ApiResult<String> {
    let raw = token::generate()?;
    let ttl = if kind == SessionKind::Browser { BROWSER_SESSION_SECS } else { DEVICE_SESSION_SECS };
    let now = now();
    state.db.create_session(user_id, &token::digest(&raw), kind, name, now, now + ttl).await?;
    state.db.record_login(user_id, now).await?;
    Ok(raw)
}

/// `Set-Cookie` value: `HttpOnly` (no JS access), `SameSite=Lax`, `Secure` over HTTPS.
/// Tokens are URL-safe base64, so the value never needs escaping.
pub(crate) fn session_cookie(
    state: &AppState,
    headers: &HeaderMap,
    value: &str,
    max_age_secs: i64,
) -> String {
    let secure = state.config.server.secure_cookies.unwrap_or_else(|| is_https(state, headers));
    format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(crate) fn is_https(state: &AppState, headers: &HeaderMap) -> bool {
    state.config.server.trust_proxy
        && headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|p| p.eq_ignore_ascii_case("https"))
}

/// Passwords only travel encrypted from outside the home: a request from beyond the home
/// network (or a private overlay like Tailscale) must come over HTTPS (through a trusted proxy),
/// else it's refused before the password is even looked at. Port-forwarding Panda's plain HTTP
/// to the internet would otherwise send passwords and session tokens in the clear.
pub(crate) fn require_safe_transport(state: &AppState, ip: ClientIp, headers: &HeaderMap) -> ApiResult<()> {
    // `secure_remote` (every request) refuses these already; kept as a second lock on passwords.
    if ip.is_local() || is_https(state, headers) {
        Ok(())
    } else {
        Err(crate::error::ApiError::Validation(
            "Signing in from outside your home network needs a secure (HTTPS) connection. Use \
             Tailscale, or put Panda behind an HTTPS reverse proxy with trust_proxy = true."
                .into(),
        ))
    }
}

/// Client IP for rate limiting. `X-Forwarded-For` is only honoured when `trust_proxy` is set,
/// otherwise anyone could spoof it to dodge limits; even then only its last (proxy-added) entry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClientIp {
    pub ip: Option<IpAddr>,
    /// The server's own address the connection reached: a client on the same IPv6 network
    /// (its first 64 bits) is at home, whatever its address range.
    pub server: Option<IpAddr>,
}

impl ClientIp {
    /// On the home network or a private overlay (Tailscale): loopback, private and link-local
    /// ranges, carrier-grade NAT (100.64.0.0/10, Tailscale's), IPv6 unique-local. Unknown
    /// addresses (no socket info) count as local.
    pub(crate) fn is_local(self) -> bool {
        if let (Some(IpAddr::V6(c)), Some(IpAddr::V6(s))) = (self.ip, self.server)
            && c.to_ipv4_mapped().is_none()
            && c.segments()[..4] == s.segments()[..4]
        {
            return true;
        }
        match self.ip {
            None => true,
            Some(IpAddr::V4(v4)) => {
                let [a, b, ..] = v4.octets();
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || (a == 100 && (64..128).contains(&b))
            }
            Some(IpAddr::V6(v6)) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return Self { ip: Some(IpAddr::V4(v4)), server: None }.is_local();
                }
                let first = v6.segments()[0];
                v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        }
    }

    pub(crate) fn key(self, prefix: &str) -> String {
        format!("{prefix}:{}", self.ip.map_or_else(|| "unknown".to_string(), |ip| ip.to_string()))
    }
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if state.config.server.trust_proxy
            && let Some(ip) = parts
                .headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                // The rightmost entry is the one our proxy added (the client's real address as
                // the proxy saw it); anything left of it came from the client and can be forged.
                .and_then(|v| v.rsplit(',').next())
                .and_then(|v| v.trim().parse().ok())
        {
            return Ok(Self { ip: Some(ip), server: None });
        }
        Ok(Self::from_connection(&parts.extensions))
    }
}

/// Both ends of a connection (what `serve` records for each one): the client's address for
/// rate limits and the home-network check, the server's for telling its IPv6 network apart.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Peer {
    pub remote: SocketAddr,
    pub local: Option<SocketAddr>,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>>
    for Peer
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        Self { remote: *stream.remote_addr(), local: stream.io().local_addr().ok() }
    }
}

impl ClientIp {
    /// From the connection itself (no proxy headers).
    fn from_connection(ext: &axum::http::Extensions) -> Self {
        if let Some(ConnectInfo(p)) = ext.get::<ConnectInfo<Peer>>() {
            return Self { ip: Some(p.remote.ip()), server: p.local.map(|l| l.ip()) };
        }
        // Tests (and anything serving with a plain address) record only the client.
        Self { ip: ext.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip()), server: None }
    }
}

/// Whose signed URL: the user and their current token generation (bumped to revoke them).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Signee {
    pub user_id: i64,
    pub token_gen: i64,
}

impl From<&panda_db::User> for Signee {
    fn from(u: &panda_db::User) -> Self {
        Self { user_id: u.id, token_gen: u.token_gen }
    }
}

impl From<&middleware::MediaGrant> for Signee {
    fn from(g: &middleware::MediaGrant) -> Self {
        Self { user_id: g.user_id, token_gen: g.token_gen }
    }
}

/// Signed URL for a stream, HLS session or subtitle (scope = path prefix ending in `/`).
pub(crate) fn sign_media(state: &AppState, who: Signee, scope: &str) -> String {
    let exp = now() as u64 + MEDIA_TOKEN_SECS;
    state.signer.sign(who.user_id, who.token_gen, scope, exp)
}

/// Token for artwork. Expiry is rounded to a week boundary so URLs stay identical for days
/// and the client's HTTP cache keeps working.
pub(crate) fn image_token(state: &AppState, who: Signee) -> String {
    let exp = (now() as u64 / WEEK_SECS + 2) * WEEK_SECS;
    state.signer.sign(who.user_id, who.token_gen, "/api/images/", exp)
}

/// How long the Apple TV Top Shelf's token lasts; the app renews it every time it runs.
pub(crate) const TOP_SHELF_TOKEN_SECS: u64 = 7 * 24 * 3600;
/// What the Top Shelf's token opens: its own read-only list, nothing else.
pub(crate) const TOP_SHELF_SCOPE: &str = "/api/topshelf/";

/// Token for the Apple TV Top Shelf extension, which runs outside the app (no session): signed
/// like media URLs, scoped to `/api/topshelf/` only.
pub(crate) fn top_shelf_token(state: &AppState, who: Signee) -> (String, u64) {
    let exp = now() as u64 + TOP_SHELF_TOKEN_SECS;
    (state.signer.sign(who.user_id, who.token_gen, TOP_SHELF_SCOPE, exp), exp)
}

pub(crate) fn with_token(path: &str, token: &str) -> String {
    format!("{path}?t={token}")
}

/// What a profile may see: its account's libraries, and titles rated up to its age limit.
/// Every list, page and stream goes through this.
#[derive(Debug, Clone, Default)]
pub(crate) struct Access {
    /// `None` = every library.
    pub libraries: Option<Vec<i64>>,
    /// `None` = no age limit. A limited profile never sees an unrated title.
    pub max_age: Option<i64>,
}

impl Access {
    pub(crate) fn library(&self, id: i64) -> bool {
        self.libraries.as_ref().is_none_or(|l| l.contains(&id))
    }

    /// A rating within the limit (an unrated title only without one).
    pub(crate) fn rating(&self, age: Option<i64>) -> bool {
        self.max_age.is_none_or(|max| age.is_some_and(|a| a <= max))
    }

    /// This profile has an age limit: things from outside the library (TMDB's lists, people's
    /// other work) carry no rating here, so they aren't shown.
    pub(crate) fn limited(&self) -> bool {
        self.max_age.is_some()
    }

    pub(crate) fn item(&self, i: &panda_db::Item) -> bool {
        self.library(i.library_id) && self.rating(i.rating_age)
    }

    pub(crate) fn title(&self, t: &crate::routes::Title) -> bool {
        self.rating(t.rating_age)
    }

    pub(crate) fn series(&self, s: &panda_db::SeriesSummary) -> bool {
        self.library(s.library_id) && self.rating(s.rating_age)
    }

    /// `filter` narrowed to what this profile may see.
    pub(crate) fn filter(&self, mut filter: panda_db::ItemFilter) -> panda_db::ItemFilter {
        filter.allowed_libraries.clone_from(&self.libraries);
        filter.max_age = self.max_age;
        filter
    }
}

/// What `user_id` may see.
pub(crate) async fn access(state: &AppState, user_id: i64) -> ApiResult<Access> {
    let user = state.db.user(user_id).await?.ok_or(crate::error::ApiError::Unauthorized)?;
    Ok(Access { libraries: state.db.allowed_libraries(&user).await?, max_age: user.max_age })
}

/// 404 (not 403) for items the user can't see (another library, over their age limit), so their
/// existence isn't revealed.
pub(crate) async fn ensure_item_access(
    state: &AppState,
    user_id: i64,
    item: &panda_db::Item,
) -> ApiResult<()> {
    if access(state, user_id).await?.item(item) { Ok(()) } else { Err(crate::error::ApiError::NotFound) }
}

#[cfg(test)]
mod network_tests {
    use super::ClientIp;

    fn ip(s: &str) -> ClientIp {
        ClientIp { ip: Some(s.parse().unwrap()), server: None }
    }

    #[test]
    fn home_networks_and_tailscale_are_local() {
        for local in [
            "127.0.0.1",
            "192.168.1.20",
            "10.0.0.5",
            "172.16.3.4",
            "100.101.102.103",
            "::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "::ffff:192.168.1.20",
        ] {
            assert!(ip(local).is_local(), "{local}");
        }
        for remote in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!ip(remote).is_local(), "{remote}");
        }
        assert!(ClientIp { ip: None, server: None }.is_local(), "no socket info: can't tell, so not refused");
        // A home device on a public IPv6 range, on the server's own network: at home.
        let at =
            |c: &str, s: &str| ClientIp { ip: Some(c.parse().unwrap()), server: Some(s.parse().unwrap()) };
        assert!(at("2601:600:8a7f:1d0::1a", "2601:600:8a7f:1d0::5").is_local());
        assert!(!at("2601:600:8a7f:1d1::1a", "2601:600:8a7f:1d0::5").is_local(), "another network");
        assert!(!at("8.8.8.8", "192.168.1.5").is_local());
    }
}
