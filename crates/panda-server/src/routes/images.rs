//! Cached TMDB artwork (media auth: session or signed `?t=`). Keys are content-addressed,
//! so responses are immutable; `private` because the URL carries a per-user token.

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use axum::routing::get;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use panda_metadata::ImageSize;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Images handed out (by key) before they're downloaded: key -> TMDB size and path. Asked for
/// early, they're fetched on the spot. Bounded: forgotten wholesale past this many.
static PROMISED: LazyLock<Mutex<HashMap<String, (ImageSize, String)>>> = LazyLock::new(Mutex::default);
const MAX_PROMISED: usize = 10_000;

/// The key a TMDB image will have, downloading it in the background: a page can list it at
/// once (headshots) and `/images/{key}` fetches it on the spot if it's asked for first.
pub(crate) fn promise(state: &AppState, size: ImageSize, path: &str) -> Option<String> {
    let key = state.images.cache_key(size, path)?;
    let tmdb = state.integrations().tmdb.clone()?;
    {
        let mut promised = PROMISED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if promised.len() >= MAX_PROMISED {
            promised.clear();
        }
        promised.insert(key.clone(), (size, path.to_owned()));
    }
    let (state, path, k) = (state.clone(), path.to_owned(), key.clone());
    tokio::spawn(async move {
        if let Err(e) = state.images.fetch(&tmdb, size, &path).await {
            tracing::debug!(key = k, error = %e, "image download failed");
        }
        PROMISED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&k);
    });
    Some(key)
}

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/images/{key}", get(image))
}

async fn image(State(state): State<AppState>, Path(key): Path<String>, req: Request) -> ApiResult<Response> {
    let path = state.images.path_for_key(&key).ok_or(ApiError::NotFound)?;
    if !tokio::fs::try_exists(&path).await? {
        // Promised but not downloaded yet: fetch it now (the background download may be queued).
        let promised = PROMISED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&key).cloned();
        let tmdb = state.integrations().tmdb.clone();
        let (Some((size, tmdb_path)), Some(tmdb)) = (promised, tmdb) else { return Err(ApiError::NotFound) };
        if state.images.fetch(&tmdb, size, &tmdb_path).await.ok().flatten().as_deref() != Some(key.as_str()) {
            return Err(ApiError::NotFound);
        }
    }
    let mut res = ServeFile::new(path)
        .oneshot(req)
        .await
        .map_err(|e| ApiError::Io(std::io::Error::other(e)))?
        .map(Body::new);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=1209600, immutable"));
    Ok(res)
}
