//! Minimal TMDB v3 client (bearer "API Read Access Token"). Only the fields Panda uses are modeled.

use reqwest::Client;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::sync::Semaphore;

use crate::{Error, Result};

const API: &str = "https://api.themoviedb.org/3/";
/// TMDB allows roughly 40-50 requests/second. Staying well below keeps 429s rare.
const MAX_IN_FLIGHT: usize = 8;

#[derive(Debug)]
pub struct Tmdb {
    http: Client,
    token: String,
    permits: Semaphore,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchMovie {
    pub id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    #[serde(default)]
    pub popularity: f64,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
    #[serde(default)]
    pub vote_average: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchTv {
    pub id: i64,
    pub name: String,
    pub original_name: Option<String>,
    pub first_air_date: Option<String>,
    #[serde(default)]
    pub popularity: f64,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
    #[serde(default)]
    pub vote_average: Option<f64>,
}

/// A trending/discover result: a movie or a show (`media_type`, or implied by the endpoint).
#[derive(Debug, Clone, Deserialize)]
pub struct Listing {
    pub id: i64,
    #[serde(default)]
    pub media_type: Option<String>,
    /// Movies.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    /// Shows.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub first_air_date: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
    #[serde(default)]
    pub vote_average: Option<f64>,
}

impl Listing {
    pub fn is_movie(&self) -> bool {
        self.media_type.as_deref() != Some("tv") && self.title.is_some()
    }
    pub fn display_title(&self) -> &str {
        self.title.as_deref().or(self.name.as_deref()).unwrap_or_default()
    }
    pub fn year(&self) -> Option<i64> {
        self.release_date.as_deref().or(self.first_air_date.as_deref())?.get(..4)?.parse().ok()
    }
}

/// A title's ids elsewhere, from TMDB.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ExternalIds {
    #[serde(default)]
    pub tvdb_id: Option<i64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Genre {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MovieDetails {
    pub id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub release_date: Option<String>,
    pub runtime: Option<i64>,
    pub vote_average: Option<f64>,
    #[serde(default)]
    pub genres: Vec<Genre>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    /// Its ids elsewhere (`append_to_response=external_ids`).
    #[serde(default)]
    pub external_ids: ExternalIds,
}

/// A movie's full details page: details plus credits and release dates, in one request.
#[derive(Debug, Clone, Deserialize)]
pub struct MovieFull {
    #[serde(default)]
    pub title: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub genres: Vec<Genre>,
    pub vote_average: Option<f64>,
    pub tagline: Option<String>,
    pub release_date: Option<String>,
    pub runtime: Option<i64>,
    pub original_language: Option<String>,
    #[serde(default)]
    pub production_companies: Vec<Company>,
    #[serde(default)]
    pub credits: Credits,
    #[serde(default)]
    pub release_dates: ReleaseDates,
    /// The series of films it's part of (sequels, prequels), if any.
    #[serde(default)]
    pub belongs_to_collection: Option<CollectionRef>,
    #[serde(default)]
    pub production_countries: Vec<Company>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Company {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollectionRef {
    pub id: i64,
    pub name: String,
}

/// A series of films (TMDB "collection"): its name and its films.
#[derive(Debug, Clone, Deserialize)]
pub struct Collection {
    pub name: String,
    #[serde(default)]
    pub parts: Vec<Listing>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Credits {
    #[serde(default)]
    pub cast: Vec<CastMember>,
    #[serde(default)]
    pub crew: Vec<CrewMember>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CastMember {
    /// TMDB person id.
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub character: Option<String>,
    pub profile_path: Option<String>,
    /// Billing order (0 = top billed).
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CrewMember {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub job: Option<String>,
    pub department: Option<String>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReleaseDates {
    #[serde(default)]
    pub results: Vec<CountryReleases>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CountryReleases {
    pub iso_3166_1: String,
    #[serde(default)]
    pub release_dates: Vec<ReleaseDate>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseDate {
    pub certification: Option<String>,
}

impl MovieFull {
    /// The age rating in `region` ("PG-13"), from the first release that has one.
    pub fn certification(&self, region: &str) -> Option<String> {
        self.release_dates
            .results
            .iter()
            .find(|c| c.iso_3166_1.eq_ignore_ascii_case(region))?
            .release_dates
            .iter()
            .filter_map(|r| r.certification.as_deref().map(str::trim))
            .find(|c| !c.is_empty())
            .map(String::from)
    }
}

/// A show's full details page: details plus credits and age ratings, in one request.
#[derive(Debug, Clone, Deserialize)]
pub struct TvFull {
    #[serde(default)]
    pub name: Option<String>,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub first_air_date: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub genres: Vec<Genre>,
    pub vote_average: Option<f64>,
    pub number_of_seasons: Option<i64>,
    pub original_language: Option<String>,
    #[serde(default)]
    pub networks: Vec<Company>,
    #[serde(default)]
    pub created_by: Vec<Creator>,
    #[serde(default)]
    pub credits: Credits,
    #[serde(default)]
    pub content_ratings: ContentRatings,
    /// "Returning Series", "Ended", "Canceled", ...
    #[serde(default)]
    pub status: Option<String>,
    /// The next episode TMDB knows of, with its air date.
    #[serde(default)]
    pub next_episode_to_air: Option<NextEpisode>,
    #[serde(default)]
    pub production_countries: Vec<Company>,
}

/// A show's next episode to air.
#[derive(Debug, Clone, Deserialize)]
pub struct NextEpisode {
    pub season_number: i64,
    pub episode_number: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Creator {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ContentRatings {
    #[serde(default)]
    pub results: Vec<ContentRating>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContentRating {
    pub iso_3166_1: String,
    pub rating: Option<String>,
}

impl TvFull {
    /// The age rating in `region` ("TV-MA").
    pub fn certification(&self, region: &str) -> Option<String> {
        self.content_ratings
            .results
            .iter()
            .find(|c| c.iso_3166_1.eq_ignore_ascii_case(region))?
            .rating
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(String::from)
    }
}

/// A person with everything they've been in or worked on.
#[derive(Debug, Clone, Deserialize)]
pub struct PersonFull {
    pub name: String,
    pub biography: Option<String>,
    pub birthday: Option<String>,
    pub deathday: Option<String>,
    pub place_of_birth: Option<String>,
    pub known_for_department: Option<String>,
    pub profile_path: Option<String>,
    #[serde(default)]
    pub combined_credits: PersonCredits,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PersonCredits {
    #[serde(default)]
    pub cast: Vec<PersonCredit>,
    #[serde(default)]
    pub crew: Vec<PersonCredit>,
}

/// One title in a person's credits (a movie or a show).
#[derive(Debug, Clone, Deserialize)]
pub struct PersonCredit {
    pub id: i64,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub name: Option<String>,
    pub release_date: Option<String>,
    pub first_air_date: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
    pub vote_average: Option<f64>,
    pub popularity: Option<f64>,
    /// Their part, or their job.
    pub character: Option<String>,
    pub job: Option<String>,
    /// Crew: Directing, Writing, Production...
    pub department: Option<String>,
    /// Cast: billing order (0 = top billed).
    pub order: Option<i64>,
    #[serde(default)]
    pub genre_ids: Vec<i64>,
    /// Shows: how many episodes they're in.
    pub episode_count: Option<i64>,
}

/// TMDB TV genres that are appearances rather than work: talk, news, reality.
const APPEARANCE_GENRES: [i64; 3] = [10767, 10763, 10764];

impl PersonCredit {
    /// Playing themselves (talk shows, documentaries, award shows), not a role or a job.
    pub fn is_appearance(&self) -> bool {
        let self_role = self.character.as_deref().is_some_and(|c| {
            let c = c.trim().to_lowercase();
            ["self", "himself", "herself", "themselves", "themself"].iter().any(|w| {
                c == *w
                    || c.starts_with(&format!("{w} "))
                    || c.starts_with(&format!("{w} -"))
                    || c.starts_with(&format!("{w} ("))
            })
        });
        self_role || self.genre_ids.iter().any(|g| APPEARANCE_GENRES.contains(g))
    }

    pub fn is_movie(&self) -> bool {
        self.media_type.as_deref() == Some("movie")
    }

    /// A show they were only briefly in (a guest spot, under three episodes).
    pub fn is_guest_spot(&self) -> bool {
        !self.is_movie() && self.episode_count.is_some_and(|n| n < 3)
    }
    /// As a discover listing (same shape as trending rows).
    pub fn listing(&self) -> Listing {
        Listing {
            id: self.id,
            media_type: self.media_type.clone(),
            title: self.title.clone(),
            release_date: self.release_date.clone(),
            name: self.name.clone(),
            first_air_date: self.first_air_date.clone(),
            overview: self.overview.clone(),
            poster_path: self.poster_path.clone(),
            vote_average: self.vote_average,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TvDetails {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub number_of_seasons: Option<i64>,
    pub original_name: Option<String>,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub first_air_date: Option<String>,
    pub vote_average: Option<f64>,
    #[serde(default)]
    pub genres: Vec<Genre>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    /// Its ids elsewhere (`append_to_response=external_ids`).
    #[serde(default)]
    pub external_ids: ExternalIds,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Season {
    pub season_number: i64,
    #[serde(default)]
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Episode {
    pub season_number: i64,
    pub episode_number: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub still_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Images {
    #[serde(default)]
    logos: Vec<ImageFile>,
}

#[derive(Debug, Deserialize)]
struct ImageFile {
    file_path: String,
    #[serde(default)]
    iso_639_1: Option<String>,
    #[serde(default)]
    vote_average: f64,
}

/// One of a show's other episode orders ("episode groups": DVD, absolute, ...).
#[derive(Debug, Clone, Deserialize)]
pub struct EpisodeGroupInfo {
    pub id: String,
    pub name: String,
    /// TMDB's kind of order (1 original air date, 2 absolute, 3 DVD, 4 digital, 5 story arc,
    /// 6 production, 7 TV).
    #[serde(rename = "type", default)]
    pub kind: i64,
    #[serde(default)]
    pub episode_count: i64,
    /// How many seasons it has.
    #[serde(default)]
    pub group_count: i64,
}

impl EpisodeGroupInfo {
    pub fn kind_label(&self) -> &'static str {
        match self.kind {
            1 => "Original air date",
            2 => "Absolute",
            3 => "DVD",
            4 => "Digital",
            5 => "Story arc",
            6 => "Production",
            7 => "TV",
            _ => "Other",
        }
    }
}

/// An episode order: its parts (seasons) and their episodes (`order` is 0-based: episode 1 is
/// order 0).
#[derive(Debug, Clone, Deserialize)]
pub struct EpisodeGroup {
    #[serde(default)]
    pub groups: Vec<GroupSeason>,
}

impl EpisodeGroup {
    /// The season number of a part. Parts count from their `order`, except in an order whose
    /// part 0 isn't specials ("Season 1" entered as part 0): those count from 1, so a file's
    /// S01 gets the part named for season 1.
    pub fn season_of(&self, part: &GroupSeason) -> i64 {
        let zero_is_a_season = self
            .groups
            .iter()
            .find(|g| g.order == 0)
            .is_some_and(|g| !g.name.to_lowercase().contains("special"));
        part.order + i64::from(zero_is_a_season)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupSeason {
    /// "Season 1", "Specials", "Part 2", ...
    #[serde(default)]
    pub name: String,
    pub order: i64,
    #[serde(default)]
    pub episodes: Vec<GroupEpisode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupEpisode {
    pub order: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub still_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Keyword {
    id: i64,
    name: String,
}

/// A person from TMDB's person search.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchPerson {
    pub id: i64,
    pub name: String,
    pub profile_path: Option<String>,
    pub known_for_department: Option<String>,
    #[serde(default)]
    pub popularity: f64,
    /// A few titles they're best known for (movies have `title`, shows `name`).
    #[serde(default)]
    pub known_for: Vec<KnownFor>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KnownFor {
    pub title: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize)]
struct Page<T> {
    results: Vec<T>,
}

impl Tmdb {
    pub fn new(read_access_token: impl Into<String>) -> Self {
        Self {
            http: crate::http_client(),
            token: read_access_token.into(),
            permits: Semaphore::new(MAX_IN_FLIGHT),
        }
    }

    pub async fn search_movie(&self, query: &str, year: Option<u16>) -> Result<Vec<SearchMovie>> {
        let year = year.map(|y| y.to_string());
        let mut q = vec![("query", query), ("include_adult", "false")];
        if let Some(y) = &year {
            q.push(("year", y));
        }
        Ok(self.get::<Page<SearchMovie>>("search/movie", &q).await?.results)
    }

    pub async fn search_tv(&self, query: &str, year: Option<u16>) -> Result<Vec<SearchTv>> {
        let year = year.map(|y| y.to_string());
        let mut q = vec![("query", query), ("include_adult", "false")];
        if let Some(y) = &year {
            q.push(("first_air_date_year", y));
        }
        Ok(self.get::<Page<SearchTv>>("search/tv", &q).await?.results)
    }

    pub async fn search_person(&self, query: &str) -> Result<Vec<SearchPerson>> {
        let q = [("query", query), ("include_adult", "false")];
        Ok(self.get::<Page<SearchPerson>>("search/person", &q).await?.results)
    }

    /// Details plus its ids elsewhere (one request).
    pub async fn movie(&self, id: i64) -> Result<MovieDetails> {
        self.get(&format!("movie/{id}"), &[("append_to_response", "external_ids")]).await
    }

    /// Details plus cast and crew and per-country release ratings (one request).
    pub async fn movie_full(&self, id: i64) -> Result<MovieFull> {
        self.get(&format!("movie/{id}"), &[("append_to_response", "credits,release_dates")]).await
    }

    /// A film series and its films (in no particular order).
    pub async fn collection(&self, id: i64) -> Result<Collection> {
        let mut c: Collection = self.get(&format!("collection/{id}"), &[]).await?;
        for p in &mut c.parts {
            p.media_type = Some("movie".into());
        }
        Ok(c)
    }

    /// A person and everything they're credited in (one request).
    pub async fn person(&self, id: i64) -> Result<PersonFull> {
        self.get(&format!("person/{id}"), &[("append_to_response", "combined_credits")]).await
    }

    /// Details plus cast and crew and per-country age ratings (one request).
    pub async fn tv_full(&self, id: i64) -> Result<TvFull> {
        self.get(&format!("tv/{id}"), &[("append_to_response", "credits,content_ratings")]).await
    }

    /// Details plus its ids elsewhere (one request).
    pub async fn tv(&self, id: i64) -> Result<TvDetails> {
        self.get(&format!("tv/{id}"), &[("append_to_response", "external_ids")]).await
    }

    /// TMDB's "you might also like" for a movie.
    pub async fn movie_recommendations(&self, id: i64) -> Result<Vec<Listing>> {
        let page: Page<Listing> = self.get(&format!("movie/{id}/recommendations"), &[]).await?;
        Ok(page
            .results
            .into_iter()
            .map(|mut l| {
                l.media_type = Some("movie".into());
                l
            })
            .collect())
    }

    /// TMDB's "you might also like" for a show.
    pub async fn tv_recommendations(&self, id: i64) -> Result<Vec<Listing>> {
        let page: Page<Listing> = self.get(&format!("tv/{id}/recommendations"), &[]).await?;
        Ok(page
            .results
            .into_iter()
            .map(|mut l| {
                l.media_type = Some("tv".into());
                l
            })
            .collect())
    }

    /// This week's trending movies and shows (people filtered out).
    pub async fn trending(&self) -> Result<Vec<Listing>> {
        let page: Page<Listing> = self.get("trending/all/week", &[]).await?;
        Ok(page
            .results
            .into_iter()
            .filter(|l| matches!(l.media_type.as_deref(), Some("movie" | "tv")))
            .collect())
    }

    /// Most popular titles on a streaming service (TMDB watch-provider id) in a region.
    pub async fn on_provider(&self, movies: bool, provider: i64, region: &str) -> Result<Vec<Listing>> {
        let provider = provider.to_string();
        let q = [
            ("with_watch_providers", provider.as_str()),
            ("watch_region", region),
            ("sort_by", "popularity.desc"),
            ("include_adult", "false"),
        ];
        let path = if movies { "discover/movie" } else { "discover/tv" };
        let page: Page<Listing> = self.get(path, &q).await?;
        let kind = if movies { "movie" } else { "tv" };
        Ok(page
            .results
            .into_iter()
            .map(|mut l| {
                l.media_type = Some(kind.into());
                l
            })
            .collect())
    }

    /// A title's logos (its name as transparent artwork), best first: English, then
    /// language-free, by votes. PNG only (some are SVG, which the image cache doesn't convert).
    pub async fn logos(&self, tv: bool, id: i64) -> Result<Vec<String>> {
        let path = format!("{}/{id}/images", if tv { "tv" } else { "movie" });
        let images: Images = self.get(&path, &[("include_image_language", "en,null")]).await?;
        let mut logos: Vec<ImageFile> = images
            .logos
            .into_iter()
            .filter(|l| {
                std::path::Path::new(&l.file_path).extension().is_some_and(|e| e.eq_ignore_ascii_case("png"))
            })
            .collect();
        logos.sort_by(|a, b| {
            (a.iso_639_1.as_deref() != Some("en"))
                .cmp(&(b.iso_639_1.as_deref() != Some("en")))
                .then(b.vote_average.total_cmp(&a.vote_average))
        });
        Ok(logos.into_iter().map(|l| l.file_path).collect())
    }

    /// TMDB's keyword id for a word ("christmas"), matched exactly (ignoring case).
    pub async fn keyword_id(&self, name: &str) -> Result<Option<i64>> {
        let page: Page<Keyword> = self.get("search/keyword", &[("query", name)]).await?;
        Ok(page.results.into_iter().find(|k| k.name.eq_ignore_ascii_case(name)).map(|k| k.id))
    }

    /// The best known movies or shows tagged with a keyword (most rated: the classics, not this
    /// week's trending obscurities), page by page (20 each).
    pub async fn with_keyword(&self, movies: bool, keyword: i64, page: u32) -> Result<Vec<Listing>> {
        let (keyword, page) = (keyword.to_string(), page.to_string());
        let q = [
            ("with_keywords", keyword.as_str()),
            ("sort_by", "vote_count.desc"),
            ("include_adult", "false"),
            ("page", page.as_str()),
        ];
        let path = if movies { "discover/movie" } else { "discover/tv" };
        let found: Page<Listing> = self.get(path, &q).await?;
        let kind = if movies { "movie" } else { "tv" };
        Ok(found
            .results
            .into_iter()
            .map(|mut l| {
                l.media_type = Some(kind.into());
                l
            })
            .collect())
    }

    /// A movie's or show's TVDB id (what Sonarr adds shows by, and `TVmaze` finds them by) and
    /// `IMDb` id (how OMDb finds it), from its TMDB id. Movies have no TVDB id.
    pub async fn external_ids(&self, tv: bool, id: i64) -> Result<ExternalIds> {
        let path = format!("{}/{id}/external_ids", if tv { "tv" } else { "movie" });
        let ids: ExternalIds = self.get(&path, &[]).await?;
        Ok(ExternalIds { imdb_id: ids.imdb_id.filter(|i| !i.is_empty()), ..ids })
    }

    /// A show's other episode orders (DVD, absolute, ...), if TMDB has any.
    pub async fn episode_groups(&self, tv_id: i64) -> Result<Vec<EpisodeGroupInfo>> {
        Ok(self.get::<Page<EpisodeGroupInfo>>(&format!("tv/{tv_id}/episode_groups"), &[]).await?.results)
    }

    /// One episode order, with every season's episodes.
    pub async fn episode_group(&self, id: &str) -> Result<EpisodeGroup> {
        self.get(&format!("tv/episode_group/{id}"), &[]).await
    }

    pub async fn season(&self, tv_id: i64, season: i64) -> Result<Season> {
        self.get(&format!("tv/{tv_id}/season/{season}"), &[]).await
    }

    /// Download raw bytes (used by the image cache for `image.tmdb.org` URLs).
    pub(crate) async fn bytes(&self, url: &str) -> Result<Vec<u8>> {
        let _permit = self.permits.acquire().await.expect("semaphore never closed");
        let res = self.http.get(url).send().await?;
        let status = res.status();
        if !status.is_success() {
            return Err(Error::Status { status, body: String::new() });
        }
        crate::read_capped(res, crate::MAX_IMAGE_BYTES).await
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T> {
        let url = format!("{API}{path}");
        let res = crate::send_with_retry(&self.permits, || {
            self.http.get(&url).bearer_auth(&self.token).query(query)
        })
        .await?;
        crate::json_or_status(res).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_groups_parse() {
        let list: Page<EpisodeGroupInfo> = serde_json::from_str(
            r#"{"results":[{"id":"5b1","name":"DVD Order","type":3,"episode_count":26,"group_count":2}]}"#,
        )
        .unwrap();
        assert_eq!(list.results[0].kind_label(), "DVD");
        let g: EpisodeGroup = serde_json::from_str(
            r#"{"groups":[{"name":"Season 1","order":1,"episodes":[
                {"order":0,"name":"Pilot","overview":"","air_date":"2008-01-20","still_path":"/a.jpg",
                 "season_number":1,"episode_number":1}]}]}"#,
        )
        .unwrap();
        assert_eq!((g.groups[0].order, g.groups[0].episodes[0].order), (1, 0));
        assert_eq!(g.season_of(&g.groups[0]), 1);
        let part = |name: &str, order: i64| GroupSeason { name: name.into(), order, episodes: Vec::new() };
        let specials_first = EpisodeGroup { groups: vec![part("Specials", 0), part("Season 1", 1)] };
        assert_eq!(specials_first.season_of(&specials_first.groups[1]), 1, "part 0 is specials: as numbered");
        let zero_based = EpisodeGroup { groups: vec![part("Season 1", 0), part("Season 2", 1)] };
        assert_eq!(zero_based.season_of(&zero_based.groups[0]), 1, "part 0 is a season: count from 1");
        assert_eq!(zero_based.season_of(&zero_based.groups[1]), 2);
    }

    #[test]
    fn movie_full_reads_credits_and_the_regions_rating() {
        let json = r#"{
            "tagline": "Fear the rise.", "release_date": "2024-03-01", "runtime": 166,
            "original_language": "en", "production_companies": [{"name": "Legendary"}],
            "credits": {
                "cast": [{"name": "Timothée Chalamet", "character": "Paul", "profile_path": "/p.jpg", "order": 0}],
                "crew": [{"name": "Denis Villeneuve", "job": "Director", "department": "Directing"}]
            },
            "release_dates": {"results": [
                {"iso_3166_1": "GB", "release_dates": [{"certification": "12A"}]},
                {"iso_3166_1": "US", "release_dates": [{"certification": ""}, {"certification": "PG-13"}]}
            ]}
        }"#;
        let m: MovieFull = serde_json::from_str(json).unwrap();
        assert_eq!(m.certification("us").as_deref(), Some("PG-13"), "skips empty ratings");
        assert_eq!(m.certification("GB").as_deref(), Some("12A"));
        assert_eq!(m.certification("FR"), None);
        assert_eq!(m.credits.cast[0].character.as_deref(), Some("Paul"));
        assert_eq!(m.credits.crew[0].job.as_deref(), Some("Director"));
        // Missing sections are fine (older or sparse entries).
        let tv: TvFull = serde_json::from_str(
            r#"{"name": "Severance", "number_of_seasons": 2, "created_by": [{"name": "Dan Erickson"}],
                "content_ratings": {"results": [{"iso_3166_1": "US", "rating": "TV-MA"}]}}"#,
        )
        .unwrap();
        assert_eq!(tv.certification("US").as_deref(), Some("TV-MA"));
        assert_eq!(tv.created_by[0].name, "Dan Erickson");
        let credit = |character: &str, genres: &[i64]| PersonCredit {
            id: 1,
            media_type: Some("tv".into()),
            title: None,
            name: Some("x".into()),
            release_date: None,
            first_air_date: None,
            poster_path: None,
            backdrop_path: None,
            overview: None,
            vote_average: None,
            popularity: None,
            character: Some(character.into()),
            job: None,
            department: None,
            order: None,
            genre_ids: genres.to_vec(),
            episode_count: Some(1),
        };
        assert!(credit("Dr. Lee", &[]).is_guest_spot(), "one episode of a show");
        assert!(credit("Self - Guest", &[]).is_appearance());
        assert!(credit("Himself", &[]).is_appearance());
        assert!(credit("Host", &[10767]).is_appearance(), "talk shows");
        assert!(!credit("Selfish Steve", &[]).is_appearance());
        assert!(!credit("Captain Kirk", &[18]).is_appearance());
        let bare: MovieFull = serde_json::from_str("{}").unwrap();
        assert!(bare.credits.cast.is_empty() && bare.certification("US").is_none());
    }
}
