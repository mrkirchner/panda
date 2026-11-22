//! Metadata for library items: TMDB lookups and matching, the extra providers (`TVmaze`, OMDb)
//! that add to TMDB, the order their answers combine in (`providers`), and a local artwork cache.
//!
//! Nothing here touches the database. `panda-server` decides what to match and stores the
//! results, and this crate answers "what is this title?" and "give me that image on disk".

pub mod fanart;
pub mod images;
pub mod matching;
pub mod omdb;
pub mod providers;
pub mod tmdb;
pub mod tvmaze;

pub use fanart::Fanart;
pub use images::{ImageCache, ImageSize};
pub use omdb::Omdb;
pub use providers::{Field, Order, Provider, RatingSource, Switches};
pub use tmdb::Tmdb;
pub use tvmaze::TvMaze;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("metadata request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("metadata service returned {status}: {body}")]
    Status { status: reqwest::StatusCode, body: String },
    #[error("metadata service rate limit still exceeded after retries")]
    RateLimited,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("response larger than {0} bytes")]
    TooLarge(usize),
    #[error("bad response: {0}")]
    Decode(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The service rejected the token or key (401, or 403 from services that answer that way).
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Error::Status { status, .. }
            if *status == reqwest::StatusCode::UNAUTHORIZED || *status == reqwest::StatusCode::FORBIDDEN)
    }
}

/// Largest picture downloaded (posters and backdrops are well under 5 MB).
pub(crate) const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// Largest JSON answer read.
pub(crate) const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;

/// Largest error body kept (only the start of it is ever shown).
const MAX_ERROR_BYTES: usize = 4096;
/// Requests to a rate-limited service are retried this many times.
const MAX_RETRIES: u32 = 4;

/// The HTTP client every provider uses: a request timeout and Panda's user agent.
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Panda/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("static client config")
}

/// Send a request (built afresh per attempt), holding one of `permits` only while it's in
/// flight, and retry 429s after the server's `Retry-After` (else 1, 2, 4... seconds). Any other
/// answer is returned as is; still limited after the retries is [`Error::RateLimited`].
pub(crate) async fn send_with_retry(
    permits: &tokio::sync::Semaphore,
    request: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response> {
    for attempt in 0..=MAX_RETRIES {
        let res = {
            let _permit = permits.acquire().await.expect("semaphore never closed");
            // Without the URL: some providers' keys travel in the query string.
            request().send().await.map_err(|e| Error::Http(e.without_url()))?
        };
        if res.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(res);
        }
        let wait = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1 << attempt);
        tracing::debug!(wait, "rate limited");
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
    }
    Err(Error::RateLimited)
}

/// A successful answer as JSON, or [`Error::Status`] with the start of the error body.
pub(crate) async fn json_or_status<T: serde::de::DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status();
    if !status.is_success() {
        let body = read_capped(res, MAX_ERROR_BYTES).await.unwrap_or_default();
        return Err(Error::Status {
            status,
            body: String::from_utf8_lossy(&body).chars().take(200).collect(),
        });
    }
    Ok(serde_json::from_slice(&read_capped(res, MAX_JSON_BYTES).await?)?)
}

/// Read a response body, refusing more than `max` bytes (a misbehaving or compromised server
/// mustn't be able to make Panda buffer an unbounded download).
pub(crate) async fn read_capped(mut res: reqwest::Response, max: usize) -> Result<Vec<u8>> {
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Err(Error::TooLarge(max));
    }
    let mut body = Vec::new();
    // Errors never carry the URL: some providers' keys travel in the query string.
    while let Some(chunk) = res.chunk().await.map_err(|e| Error::Http(e.without_url()))? {
        if body.len() + chunk.len() > max {
            return Err(Error::TooLarge(max));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
