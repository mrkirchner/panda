//! Auth middleware. Routes are grouped by what they require, so a new route can't silently
//! end up public: public | user | admin | media (session or signed URL).

use axum::extract::{OriginalUri, Request, State};
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::Response;

use super::{AuthVia, CurrentUser, authenticate};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::now;
use crate::state::AppState;

/// Grants read access to one media path, from a session or a valid `?t=` signature.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MediaGrant {
    pub user_id: i64,
    /// The user's token generation (for URLs signed while serving this request).
    pub token_gen: i64,
}

/// Outside the home network, only HTTPS (through a trusted proxy): a plain-HTTP port forward
/// is refused outright, before anything is read, instead of carrying session tokens, signed
/// links and streams in the clear. The health check stays open (it says nothing). Off with
/// `[server] allow_insecure_remote`.
pub(crate) async fn secure_remote(State(state): State<AppState>, req: Request, next: Next) -> Response {
    use axum::extract::FromRequestParts as _;
    use axum::response::IntoResponse as _;
    if state.config.server.allow_insecure_remote || req.uri().path() == "/health" {
        return next.run(req).await;
    }
    let (mut parts, body) = req.into_parts();
    let Ok(ip) = super::ClientIp::from_request_parts(&mut parts, &state).await;
    if ip.is_local() || super::is_https(&state, &parts.headers) {
        return next.run(Request::from_parts(parts, body)).await;
    }
    (
        axum::http::StatusCode::FORBIDDEN,
        "Panda only answers from outside your home network over HTTPS: put it behind an HTTPS \
         reverse proxy (with trust_proxy = true) or use a VPN such as Tailscale.\n",
    )
        .into_response()
}

pub(crate) async fn require_user(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> ApiResult<Response> {
    let user = authenticate(&state, req.headers()).await?.ok_or(ApiError::Unauthorized)?;
    csrf_check(&user, req.method(), req.headers())?;
    req.extensions_mut().insert(user);
    Ok(next.run(req).await)
}

pub(crate) async fn require_admin(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> ApiResult<Response> {
    let user = authenticate(&state, req.headers()).await?.ok_or(ApiError::Unauthorized)?;
    if !user.is_admin() {
        return Err(ApiError::Forbidden);
    }
    csrf_check(&user, req.method(), req.headers())?;
    req.extensions_mut().insert(user);
    Ok(next.run(req).await)
}

pub(crate) async fn require_media(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> ApiResult<Response> {
    let grant = if let Some(user) = authenticate(&state, req.headers()).await? {
        MediaGrant { user_id: user.user.id, token_gen: user.user.token_gen }
    } else {
        // Nested routers see a stripped path; signatures cover the full original path.
        let uri = req.extensions().get::<OriginalUri>().map_or_else(|| req.uri().clone(), |o| o.0.clone());
        let token = uri
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t=")))
            .ok_or(ApiError::Unauthorized)?;
        let (user_id, token_gen) =
            state.signer.verify(token, uri.path(), now() as u64).ok_or(ApiError::Unauthorized)?;
        // A signed URL stops working once its user is disabled or deleted, or its token
        // generation moved on (password change, sign out everywhere).
        match state.db.user(user_id).await? {
            Some(u) if !u.disabled && u.token_gen == token_gen => MediaGrant { user_id, token_gen },
            _ => return Err(ApiError::Unauthorized),
        }
    };
    req.extensions_mut().insert(grant);
    Ok(next.run(req).await)
}

/// CSRF defense for cookie-authenticated, state-changing requests: the browser-supplied
/// Origin (or Referer) must match the Host. Bearer-token clients aren't exposed to CSRF.
fn csrf_check(user: &CurrentUser, method: &Method, headers: &HeaderMap) -> ApiResult<()> {
    if user.via != AuthVia::Cookie || matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Ok(());
    }
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).ok_or(ApiError::Forbidden)?;
    let origin = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Forbidden)?;
    let origin_host = origin.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or_default();
    if origin_host.eq_ignore_ascii_case(host) { Ok(()) } else { Err(ApiError::Forbidden) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use panda_db::{Role, User};

    fn user(via: AuthVia) -> CurrentUser {
        CurrentUser {
            user: User {
                id: 1,
                username: "a".into(),
                role: Role::Admin,
                disabled: false,
                created_at: 0,
                last_login_at: None,
                account_id: 1,
                managed: false,
                display_name: None,
                language: None,
                avatar: None,
                email: None,
                preview_sound: true,
                token_gen: 0,
                max_age: None,
            },
            session_id: 1,
            via,
        }
    }

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        h
    }

    #[test]
    fn csrf_rules() {
        let cookie = user(AuthVia::Cookie);
        let same = headers("nas:8096", Some("http://nas:8096"));
        let other_port = headers("nas:8096", Some("http://nas:8080"));
        let none = headers("nas:8096", None);
        assert!(csrf_check(&cookie, &Method::POST, &same).is_ok());
        assert!(csrf_check(&cookie, &Method::POST, &other_port).is_err(), "same site, different origin");
        assert!(csrf_check(&cookie, &Method::DELETE, &none).is_err(), "missing origin");
        assert!(csrf_check(&cookie, &Method::GET, &other_port).is_ok(), "reads are safe");
        assert!(csrf_check(&user(AuthVia::Bearer), &Method::POST, &none).is_ok(), "bearer clients");
    }
}
