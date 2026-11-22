//! Connection speed test for the players' Auto quality.

use std::convert::Infallible;
use std::sync::LazyLock;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use serde::Deserialize;

use crate::auth::CurrentUser;
use crate::auth::limiter::Limit;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const CHUNK: usize = 64 * 1024;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const PER_USER: Limit = Limit::per_minutes(30, 10);

/// 1 MiB of pseudo-random bytes, built once. Incompressible, so neither our compression layer
/// nor a proxy can make the link look faster than it is.
static NOISE: LazyLock<Bytes> = LazyLock::new(|| {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut buf = Vec::with_capacity(1 << 20);
    while buf.len() < (1 << 20) {
        // xorshift64*
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        buf.extend_from_slice(&x.wrapping_mul(0x2545_f491_4f6c_dd1d).to_le_bytes());
    }
    Bytes::from(buf)
});

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/speedtest", get(speedtest))
}

#[derive(Deserialize)]
struct SpeedQuery {
    bytes: usize,
}

/// Stream `bytes` (64 KiB to 64 MiB) of noise. The client times the download.
async fn speedtest(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Query(q): Query<SpeedQuery>,
) -> ApiResult<Response> {
    state.limiter.hit(&format!("speedtest:{}", me.user.id), PER_USER).map_err(ApiError::TooManyRequests)?;
    let total = q.bytes.clamp(CHUNK, MAX_BYTES);
    let noise = NOISE.clone();
    let chunks = (0..total.div_ceil(CHUNK)).map(move |i| {
        let len = CHUNK.min(total - i * CHUNK);
        let start = (i * CHUNK) % (noise.len() - CHUNK);
        Ok::<_, Infallible>(noise.slice(start..start + len))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::CONTENT_LENGTH, total.to_string()),
        ],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response())
}
