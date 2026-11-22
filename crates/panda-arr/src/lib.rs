//! Typed clients for the Sonarr and Radarr v3 APIs, plus their webhook payloads.
//!
//! Only the fields Panda uses are modeled. Both APIs return many more, which serde ignores.

pub mod bazarr;
mod client;
pub mod progress;
pub mod radarr;
pub mod sonarr;
pub mod webhook;

pub use bazarr::Bazarr;
pub use client::ArrClient;
pub use radarr::Radarr;
pub use sonarr::Sonarr;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid base url: {0}")]
    Url(#[from] url::ParseError),
    #[error("request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{service} returned {status}: {body}")]
    Status { service: &'static str, status: reqwest::StatusCode, body: String },
    #[error("response missing {0}")]
    Missing(&'static str),
    #[error("response larger than {0} bytes")]
    TooLarge(usize),
    #[error("bad response: {0}")]
    Decode(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Largest answer read from Radarr/Sonarr (a big library's full list is tens of MB).
pub(crate) const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// Read a response body, refusing more than `max` bytes (a misbehaving or compromised server
/// mustn't be able to make Panda buffer an unbounded download).
pub(crate) async fn read_capped(mut res: reqwest::Response, max: usize) -> Result<Vec<u8>> {
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Err(Error::TooLarge(max));
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if body.len() + chunk.len() > max {
            return Err(Error::TooLarge(max));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub app_name: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityProfile {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFolder {
    pub id: i64,
    pub path: String,
    pub free_space: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub cover_type: String,
    pub remote_url: Option<String>,
}

/// Defaults applied when Panda adds something to Sonarr/Radarr.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddDefaults {
    pub quality_profile_id: i64,
    pub root_folder: String,
}
