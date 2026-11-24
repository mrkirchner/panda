//! The admin web UI (a static SPA build), and the TV app and the web app for watching served in
//! a browser (`/tv`, `/watch`). Built into the binary (see `build.rs`), so one
//! program is the whole server; `[server] web_dir` serves a folder instead (development).
//! Hashed assets are cached forever, `index.html` never, and unknown paths fall back to
//! `index.html` for client-side routing.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

/// Same-origin only: no inline scripts, no third-party anything, no framing.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                   img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; \
                   base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

#[derive(Embed)]
#[folder = "$OUT_DIR/web"]
struct Bundled;

#[derive(Embed)]
#[folder = "$OUT_DIR/tv"]
struct BundledTv;

#[derive(Embed)]
#[folder = "$OUT_DIR/watch"]
struct BundledWatch;

/// The TV app needs more than the admin UI: WebGL textures and video from `blob:` URLs, image
/// decoding in workers, and media from the server (still same-origin only, no framing).
const TV_CSP: &str = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; \
                      style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
                      media-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:; \
                      object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// The web app for watching (`/watch`): video from `blob:` URLs (shaka-player's media source),
/// artwork and media from the server; same-origin only, no framing, no inline scripts.
const WATCH_CSP: &str = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; \
                         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
                         media-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:; \
                         object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// One file of an embedded app served under `prefix`, else its `index.html` (client-side
/// routing); hashed assets are cached forever, the rest revalidated.
fn serve_embedded(
    req: &Request,
    prefix: &str,
    get: fn(&str) -> Option<rust_embed::EmbeddedFile>,
    csp: &'static str,
    missing: &'static str,
) -> Response {
    let path = req.uri().path().trim_start_matches(prefix).trim_start_matches('/');
    let Some(index) = get("index.html") else {
        return (StatusCode::NOT_FOUND, missing).into_response();
    };
    let is_asset = path.starts_with("assets/");
    let file = match get(path) {
        Some(f) if !path.is_empty() => f,
        _ if is_asset => return StatusCode::NOT_FOUND.into_response(),
        _ => index,
    };
    let mut res = Response::new(Body::from(file.data.into_owned()));
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(file.metadata.mimetype()) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    let cache = if is_asset { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

/// The TV app in a browser (`/tv`): the same app the TVs run, talking to this server.
pub(super) async fn serve_tv(req: Request) -> Response {
    serve_embedded(
        &req,
        "/tv",
        BundledTv::get,
        TV_CSP,
        "TV app not built. Run `pnpm build:server` in clients/tv.",
    )
}

/// The web app for watching (`/watch`, clients/web): history routing, so every unknown path
/// under it is the app's `index.html`.
pub(super) async fn serve_watch(req: Request) -> Response {
    serve_embedded(
        &req,
        "/watch",
        BundledWatch::get,
        WATCH_CSP,
        "Web app not built. Run `pnpm build` in clients/web.",
    )
}

/// Whether this binary carries the admin UI.
pub(crate) fn bundled() -> bool {
    Bundled::get("index.html").is_some()
}

pub(super) async fn serve(State(state): State<AppState>, req: Request) -> Response {
    let is_asset = req.uri().path().starts_with("/assets/");
    let mut res = if let Some(dir) = state.web_dir.clone() {
        let index = dir.join("index.html");
        match ServeDir::new(&dir).fallback(ServeFile::new(&index)).oneshot(req).await {
            Ok(r) => r.map(Body::new),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    } else if bundled() {
        let path = req.uri().path().trim_start_matches('/');
        // A file, else the app (its router handles the path); missing assets are 404s.
        let (file, name) = match Bundled::get(path) {
            Some(f) if !path.is_empty() => (f, path),
            _ if is_asset => return StatusCode::NOT_FOUND.into_response(),
            _ => (Bundled::get("index.html").expect("bundled() checked"), "index.html"),
        };
        let mime = mime_type(name);
        let mut r = Response::new(Body::from(file.data.into_owned()));
        if let Ok(v) = HeaderValue::from_str(&mime) {
            r.headers_mut().insert(header::CONTENT_TYPE, v);
        }
        r
    } else {
        return (
            StatusCode::NOT_FOUND,
            "Admin UI not built. Run `pnpm build` in clients/admin, or `pnpm dev` for development.",
        )
            .into_response();
    };
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    let cache = if is_asset { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn mime_type(name: &str) -> String {
    Bundled::get(name)
        .map_or_else(|| "application/octet-stream".to_string(), |f| f.metadata.mimetype().to_string())
}
