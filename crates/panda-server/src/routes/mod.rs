//! HTTP routes, grouped by what they require so a new route can't silently become public:
//!
//! - public: health, setup, login, invite acceptance, TV device sign-in, webhook (own token),
//!   metadata providers' credits (About)
//! - user:   everything else under `/api` (session cookie or bearer token)
//! - media:  streams, HLS, subtitles, artwork (session *or* signed `?t=` URL)
//! - admin:  `/api/admin/*` (admin role)

mod admin;
mod auth;
mod clips;
mod favorites;
mod featured;
mod genre;
pub(crate) mod home_more;
mod images;
mod library;
mod matches;
mod network;
mod notifications;
mod playback;
mod requests;
mod search;
pub(crate) mod titles;
mod watch;
mod web;
mod webhooks;

use axum::Router;
use axum::http::{HeaderName, HeaderValue, header};
use axum::middleware::from_fn_with_state;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::auth::middleware::{require_admin, require_media, require_user};
use crate::state::AppState;

/// Whether the admin UI is built into this binary.
/// For the in-memory catalog (`crate::catalog`).
pub(crate) use titles::{Title, group_movies};
pub(crate) use watch::watch_key;

pub(crate) fn web_bundled() -> bool {
    web::bundled()
}

pub fn router(state: AppState) -> Router {
    let public = auth::public_routes();
    let user = Router::new()
        .merge(auth::user_routes())
        .merge(library::routes())
        .merge(playback::user_routes())
        .merge(requests::routes())
        .merge(notifications::routes())
        .merge(network::routes())
        .merge(titles::routes())
        .merge(watch::routes())
        .merge(home_more::routes())
        .merge(genre::routes())
        .merge(favorites::routes())
        .merge(search::routes())
        .merge(clips::user_routes())
        .route_layer(from_fn_with_state(state.clone(), require_user));
    let media = Router::new()
        .merge(playback::media_routes())
        .merge(images::routes())
        .merge(clips::media_routes())
        .merge(watch::media_routes())
        .route_layer(from_fn_with_state(state.clone(), require_media));
    let admin = admin::routes()
        .merge(matches::routes())
        .route_layer(from_fn_with_state(state.clone(), require_admin));

    let api = Router::new()
        .merge(public)
        .merge(user)
        .merge(media)
        .nest("/admin", admin)
        // Unknown API paths are JSON 404s, never the web UI's index.html.
        .fallback(|| async { crate::error::ApiError::NotFound });

    Router::new()
        .nest("/api", api)
        .merge(webhooks::routes())
        .route("/health", axum::routing::get(|| async { "ok" }))
        // The TV app in a browser: one address, `/tv/` (its router is hash-based).
        .route("/tv", axum::routing::get(|| async { axum::response::Redirect::permanent("/tv/") }))
        .route("/tv/", axum::routing::get(web::serve_tv))
        .route("/tv/{*rest}", axum::routing::get(web::serve_tv))
        // The web app for watching (clients/watch), for phones, tablets and computers.
        .route("/watch", axum::routing::get(|| async { axum::response::Redirect::permanent("/watch/") }))
        .route("/watch/", axum::routing::get(web::serve_watch))
        .route("/watch/{*rest}", axum::routing::get(web::serve_watch))
        .fallback(web::serve)
        // Compress JSON/VTT/playlists. Video is already compressed, so skip it.
        .layer(
            CompressionLayer::new().compress_when(
                DefaultPredicate::new()
                    .and(NotForContentType::const_new("video/"))
                    .and(NotForContentType::const_new("application/octet-stream")),
            ),
        )
        // TV apps run from other origins (file://, app://, dev servers) and authenticate with
        // bearer tokens, so CORS stays open, but *without* credentials: browsers never attach
        // the session cookie to cross-origin requests.
        .layer(CorsLayer::permissive())
        .layer(security_header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        // Signed media URLs must never leak to other sites via Referer.
        .layer(security_header(header::REFERRER_POLICY, "no-referrer"))
        .layer(security_header(header::X_FRAME_OPTIONS, "DENY"))
        .layer(security_header(HeaderName::from_static("cross-origin-resource-policy"), "cross-origin"))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn security_header(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
}
