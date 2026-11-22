//! Minimal `TVmaze` client (free, no key; data CC BY-SA). Used only to fill in what TMDB lacks
//! for a show's episodes: names, overviews, air dates and episodes TMDB doesn't list.
//! Shows are found by the TVDB or `IMDb` id TMDB gives, never by name.

use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::Result;
use crate::tmdb::ExternalIds;

const API: &str = "https://api.tvmaze.com/";
/// `TVmaze` allows 20 calls every 10 seconds per IP.
const MAX_IN_FLIGHT: usize = 2;

#[derive(Debug)]
pub struct TvMaze {
    http: Client,
    permits: Semaphore,
}

#[derive(Debug, Deserialize)]
struct Show {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct RawEpisode {
    season: i64,
    /// `None` for specials `TVmaze` doesn't number.
    number: Option<i64>,
    name: Option<String>,
    airdate: Option<String>,
    summary: Option<String>,
}

impl RawEpisode {
    fn clean(self) -> Option<Episode> {
        Some(Episode {
            season: self.season,
            episode: self.number?,
            name: self.name.filter(|n| !n.trim().is_empty()),
            overview: self.summary.as_deref().map(plain_text).filter(|s| !s.is_empty()),
            air_date: self.airdate.filter(|d| !d.is_empty()),
        })
    }
}

/// One episode, cleaned up: plain-text overview, empty strings as `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Episode {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
}

impl Default for TvMaze {
    fn default() -> Self {
        Self::new()
    }
}

impl TvMaze {
    pub fn new() -> Self {
        Self { http: crate::http_client(), permits: Semaphore::new(MAX_IN_FLIGHT) }
    }

    /// `TVmaze`'s id for a show, by its TVDB id first, then `IMDb`. `None` when neither is known.
    pub async fn find(&self, ids: &ExternalIds) -> Result<Option<i64>> {
        if let Some(tvdb) = ids.tvdb_id {
            let tvdb = tvdb.to_string();
            if let Some(s) = self.get::<Show>("lookup/shows", &[("thetvdb", &tvdb)]).await? {
                return Ok(Some(s.id));
            }
        }
        if let Some(imdb) = ids.imdb_id.as_deref().filter(|i| !i.is_empty())
            && let Some(s) = self.get::<Show>("lookup/shows", &[("imdb", imdb)]).await?
        {
            return Ok(Some(s.id));
        }
        Ok(None)
    }

    /// Every numbered episode of a show (specials included when `TVmaze` numbers them).
    pub async fn episodes(&self, show_id: i64) -> Result<Vec<Episode>> {
        let raw: Vec<RawEpisode> =
            self.get(&format!("shows/{show_id}/episodes"), &[("specials", "1")]).await?.unwrap_or_default();
        Ok(raw.into_iter().filter_map(RawEpisode::clean).collect())
    }

    /// GET a JSON answer; `None` on 404 (`TVmaze`'s "no such show").
    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Option<T>> {
        let url = format!("{API}{path}");
        let res = crate::send_with_retry(&self.permits, || self.http.get(&url).query(query)).await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        crate::json_or_status(res).await.map(Some)
    }
}

/// `TVmaze` summaries are HTML (`<p>He <b>runs</b>.</p>`): keep the text, decode common entities.
fn plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let words: Vec<&str> = decoded.split_whitespace().collect();
    // Tags became spaces: don't leave one before punctuation ("<b>runs</b>." -> "runs .").
    words.join(" ").replace(" .", ".").replace(" ,", ",").replace(" !", "!").replace(" ?", "?")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_html_becomes_plain_text() {
        assert_eq!(plain_text("<p>He <b>runs</b>.</p>"), "He runs.");
        assert_eq!(plain_text("<p>Tom &amp; Jerry&#39;s &quot;day&quot;</p>"), "Tom & Jerry's \"day\"");
        assert_eq!(plain_text("<p>One.</p><p>Two.</p>"), "One. Two.");
        assert_eq!(plain_text(""), "");
    }

    #[test]
    fn episodes_parse_and_skip_unnumbered_specials() {
        let json = r#"[
            {"season":1,"number":1,"name":"Pilot","airdate":"2008-01-20","summary":"<p>Walt.</p>"},
            {"season":1,"number":null,"name":"Special","airdate":"","summary":null},
            {"season":2,"number":3,"name":"","airdate":"","summary":""}
        ]"#;
        let raw: Vec<RawEpisode> = serde_json::from_str(json).unwrap();
        let eps: Vec<Episode> = raw.into_iter().filter_map(RawEpisode::clean).collect();
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[0].overview.as_deref(), Some("Walt."));
        assert_eq!(eps[1], Episode { season: 2, episode: 3, name: None, overview: None, air_date: None });
    }
}
