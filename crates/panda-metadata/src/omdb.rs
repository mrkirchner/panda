//! Minimal OMDb client (user's own key; free tier 1,000 requests a day; data CC BY-NC 4.0).
//! Supplies `IMDb`, Rotten Tomatoes and Metacritic ratings, and a plot. Titles are found by
//! their `IMDb` id (from TMDB), never by name.
//!
//! The key travels in the query string, so request errors are stripped of their URL before
//! they can reach a log.

use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::{Error, Result};

const API: &str = "https://www.omdbapi.com/";
const MAX_IN_FLIGHT: usize = 4;

#[derive(Debug)]
pub struct Omdb {
    http: Client,
    key: String,
    permits: Semaphore,
}

/// One rating, as OMDb gives it ("8.3/10", "91%", "74/100").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rating {
    /// `imdb`, `rotten_tomatoes` or `metacritic`.
    pub source: &'static str,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Found {
    pub plot: Option<String>,
    pub ratings: Vec<Rating>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Answer {
    response: String,
    error: Option<String>,
    plot: Option<String>,
    #[serde(default)]
    ratings: Vec<RawRating>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawRating {
    source: String,
    value: String,
}

/// Rating sources by OMDb's name for them, and the source id Panda stores them under (labels are
/// in `providers::Spec::ratings`).
const SOURCES: [(&str, &str); 3] = [
    ("Internet Movie Database", "imdb"),
    ("Rotten Tomatoes", "rotten_tomatoes"),
    ("Metacritic", "metacritic"),
];

impl Omdb {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self { http: crate::http_client(), key: api_key.into(), permits: Semaphore::new(MAX_IN_FLIGHT) }
    }

    /// A title by `IMDb` id (`tt0113277`). `None`: OMDb doesn't know it. A bad key is a 401
    /// [`Error::Status`]; the daily limit is [`Error::RateLimited`].
    pub async fn by_imdb(&self, imdb_id: &str) -> Result<Option<Found>> {
        let query = [("apikey", self.key.as_str()), ("i", imdb_id), ("plot", "full")];
        let res = crate::send_with_retry(&self.permits, || self.http.get(API).query(&query)).await?;
        let status = res.status();
        let body = crate::read_capped(res, crate::MAX_JSON_BYTES).await?;
        let Ok(answer) = serde_json::from_slice::<Answer>(&body) else {
            return Err(Error::Status {
                status,
                body: String::from_utf8_lossy(&body).chars().take(200).collect(),
            });
        };
        parse(status, answer)
    }
}

fn parse(status: StatusCode, a: Answer) -> Result<Option<Found>> {
    if a.response != "True" {
        let msg = a.error.unwrap_or_default();
        let lower = msg.to_lowercase();
        if lower.contains("limit") {
            return Err(Error::RateLimited);
        }
        if lower.contains("api key") || status == StatusCode::UNAUTHORIZED {
            return Err(Error::Status { status: StatusCode::UNAUTHORIZED, body: msg });
        }
        // "Incorrect IMDb ID." / "Movie not found!" / "Series not found!": OMDb doesn't have it.
        // Anything else ("Error getting data.") is a fault, so the title is asked again soon.
        if lower.contains("not found") || lower.contains("incorrect imdb id") {
            return Ok(None);
        }
        return Err(Error::Status { status, body: msg });
    }
    let ratings = a
        .ratings
        .into_iter()
        .filter_map(|r| {
            let source = SOURCES.iter().find(|s| s.0 == r.source)?.1;
            (r.value != "N/A" && !r.value.is_empty()).then_some(Rating { source, value: r.value })
        })
        .collect();
    let plot = a.plot.filter(|p| p != "N/A" && !p.trim().is_empty());
    Ok(Some(Found { plot, ratings }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(json: &str) -> Answer {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn ratings_and_plot_parse() {
        let a = answer(
            r#"{"Response":"True","Plot":"A heist.","Ratings":[
                {"Source":"Internet Movie Database","Value":"8.3/10"},
                {"Source":"Rotten Tomatoes","Value":"88%"},
                {"Source":"Metacritic","Value":"N/A"},
                {"Source":"Somewhere","Value":"5"}]}"#,
        );
        let f = parse(StatusCode::OK, a).unwrap().unwrap();
        assert_eq!(f.plot.as_deref(), Some("A heist."));
        assert_eq!(
            f.ratings,
            vec![
                Rating { source: "imdb", value: "8.3/10".into() },
                Rating { source: "rotten_tomatoes", value: "88%".into() },
            ]
        );
    }

    #[test]
    fn errors_are_told_apart() {
        let missing = answer(r#"{"Response":"False","Error":"Incorrect IMDb ID."}"#);
        assert_eq!(parse(StatusCode::OK, missing).unwrap(), None);
        let limit = answer(r#"{"Response":"False","Error":"Request limit reached!"}"#);
        assert!(matches!(parse(StatusCode::UNAUTHORIZED, limit), Err(Error::RateLimited)));
        let key = answer(r#"{"Response":"False","Error":"Invalid API key!"}"#);
        assert!(
            matches!(parse(StatusCode::UNAUTHORIZED, key), Err(Error::Status { status, .. }) if status == 401)
        );
        let fault = answer(r#"{"Response":"False","Error":"Error getting data."}"#);
        assert!(matches!(parse(StatusCode::OK, fault), Err(Error::Status { .. })), "faults are retried");
        let na = answer(r#"{"Response":"True","Plot":"N/A"}"#);
        assert_eq!(parse(StatusCode::OK, na).unwrap(), Some(Found::default()));
    }
}
