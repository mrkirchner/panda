//! Minimal Fanart.tv client (the admin's own personal key, free). Supplies artwork: posters,
//! backdrops and logos (a title's name as transparent artwork). Movies are found by their TMDB
//! id, shows by their TVDB id, never by name.
//!
//! The key travels in the query string: request errors never carry the URL (see
//! `send_with_retry`).

use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::Result;

const API: &str = "https://webservice.fanart.tv/v3/";
const MAX_IN_FLIGHT: usize = 4;

#[derive(Debug)]
pub struct Fanart {
    http: Client,
    key: String,
    permits: Semaphore,
}

/// The best artwork Fanart.tv has for a title: image URLs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Art {
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub logo: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Image {
    url: String,
    #[serde(default)]
    lang: String,
    /// A number, as a string.
    #[serde(default)]
    likes: String,
}

#[derive(Debug, Default, Deserialize)]
struct Answer {
    #[serde(default)]
    movieposter: Vec<Image>,
    #[serde(default)]
    moviebackground: Vec<Image>,
    #[serde(default)]
    hdmovielogo: Vec<Image>,
    #[serde(default)]
    movielogo: Vec<Image>,
    #[serde(default)]
    tvposter: Vec<Image>,
    #[serde(default)]
    showbackground: Vec<Image>,
    #[serde(default)]
    hdtvlogo: Vec<Image>,
    #[serde(default)]
    clearlogo: Vec<Image>,
}

/// The best of `images`: in English (artwork with lettering), else without text (`00` or no
/// language: what backdrops usually are), else any; the most liked first.
fn best(images: &[Image], prefer_text: bool) -> Option<String> {
    let rank = |i: &Image| -> u8 {
        let textless = i.lang.is_empty() || i.lang == "00";
        match (i.lang == "en", textless) {
            (true, _) if prefer_text => 0,
            (_, true) if !prefer_text => 0,
            (true, _) | (_, true) => 1,
            _ => 2,
        }
    };
    images
        .iter()
        .filter(|i| i.url.starts_with("https://"))
        .min_by_key(|i| (rank(i), std::cmp::Reverse(i.likes.parse::<u32>().unwrap_or(0))))
        .map(|i| i.url.clone())
}

impl Answer {
    fn movie(&self) -> Art {
        Art {
            poster: best(&self.movieposter, true),
            backdrop: best(&self.moviebackground, false),
            logo: best(&self.hdmovielogo, true).or_else(|| best(&self.movielogo, true)),
        }
    }

    fn show(&self) -> Art {
        Art {
            poster: best(&self.tvposter, true),
            backdrop: best(&self.showbackground, false),
            logo: best(&self.hdtvlogo, true).or_else(|| best(&self.clearlogo, true)),
        }
    }
}

impl Fanart {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self { http: crate::http_client(), key: api_key.into(), permits: Semaphore::new(MAX_IN_FLIGHT) }
    }

    /// A movie's artwork, by its TMDB id. `None`: Fanart.tv has nothing for it. A bad key is a
    /// 401 [`crate::Error::Status`].
    pub async fn movie(&self, tmdb_id: i64) -> Result<Option<Art>> {
        Ok(self.get(&format!("movies/{tmdb_id}")).await?.map(|a| a.movie()))
    }

    /// A show's artwork, by its TVDB id.
    pub async fn show(&self, tvdb_id: i64) -> Result<Option<Art>> {
        Ok(self.get(&format!("tv/{tvdb_id}")).await?.map(|a| a.show()))
    }

    async fn get(&self, path: &str) -> Result<Option<Answer>> {
        let url = format!("{API}{path}");
        let res =
            crate::send_with_retry(&self.permits, || self.http.get(&url).query(&[("api_key", &self.key)]))
                .await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        crate::json_or_status(res).await.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_english_lettering_and_textless_backdrops_most_liked_first() {
        let a: Answer = serde_json::from_str(
            r#"{
            "movieposter": [
                {"url":"https://assets.fanart.tv/p-de.jpg","lang":"de","likes":"9"},
                {"url":"https://assets.fanart.tv/p-en-1.jpg","lang":"en","likes":"1"},
                {"url":"https://assets.fanart.tv/p-en-5.jpg","lang":"en","likes":"5"}],
            "moviebackground": [
                {"url":"https://assets.fanart.tv/b-en.jpg","lang":"en","likes":"7"},
                {"url":"https://assets.fanart.tv/b-none.jpg","lang":"","likes":"2"}],
            "movielogo": [{"url":"https://assets.fanart.tv/l.png","lang":"en","likes":"0"}],
            "tvposter": [{"url":"http://insecure.example/x.jpg","lang":"en","likes":"3"}]
        }"#,
        )
        .unwrap();
        let m = a.movie();
        assert_eq!(m.poster.as_deref(), Some("https://assets.fanart.tv/p-en-5.jpg"));
        assert_eq!(m.backdrop.as_deref(), Some("https://assets.fanart.tv/b-none.jpg"));
        assert_eq!(m.logo.as_deref(), Some("https://assets.fanart.tv/l.png"), "SD logo when no HD one");
        assert_eq!(a.show().poster, None, "only https images");
    }
}
