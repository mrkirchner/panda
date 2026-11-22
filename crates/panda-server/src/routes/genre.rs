//! A genre's page (`/api/genres/{name}`): built from the library alone (the catalog), like a
//! store's genre page: a banner, featured titles, the top ten, what's new, and the genres it's
//! most often paired with (on Comedy: Animation, Romance...), movies and shows together.
//! The Movies and Shows pages (`/api/browse/{kind}`) are the same page over one kind, with a
//! row for each of its main genres.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use panda_db::SeriesSummary;
use serde::Serialize;

use super::featured::{self, Rng};
use super::home_more::{Spot, add_logos, genres_of, movie_spot, show_spot};
use super::titles::{Title, movie_titles};
use crate::auth::{CurrentUser, allowed_libraries};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::now;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/genres/{name}", get(genre_page))
        .route("/browse/{kind}", get(kind_page))
        .route("/browse/library/{id}", get(library_page))
}

/// Featured titles at the top (half the newest, half the best rated).
const FEATURED: usize = 6;
const TOP: usize = 10;
const ROW: usize = 20;
/// Rows for the genres most often paired with this one, each needing this many titles.
const PAIRED_ROWS: usize = 4;
const PAIRED_MIN: usize = 4;
/// Genre rows on the Movies and Shows pages.
const KIND_ROWS: usize = 10;

#[derive(Serialize)]
struct GenrePage {
    name: String,
    /// The banner's backdrop (image key).
    backdrop: Option<String>,
    /// Which library list "See all" opens (`movies` or `shows`: whichever has more).
    kind: &'static str,
    /// How many titles (movies and shows) have it.
    count: usize,
    featured: Vec<Spot>,
    top: Vec<Spot>,
    recent: Vec<Spot>,
    paired: Vec<PairedRow>,
}

/// Titles of this genre that are also of `genre`.
#[derive(Serialize)]
struct PairedRow {
    genre: String,
    items: Vec<Spot>,
}

/// One title of the genre, movie or show, with what the page sorts by.
struct Entry<'a> {
    spot: Spot,
    rating: f64,
    added_at: &'a str,
    genres: Vec<&'a str>,
}

async fn genre_page(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(name): Path<String>,
) -> ApiResult<Json<GenrePage>> {
    let movies = movie_titles(&state, me.user.id, None).await?;
    let allowed = allowed_libraries(&state, me.user.id).await?;
    let shows = crate::catalog::series(&state, allowed.as_deref()).await?;
    let mut page = build(Some(&name), &movies, &shows, featured::daily_seed(now(), me.user.id))
        .ok_or(ApiError::NotFound)?;
    add_logos(&state, page.featured.iter_mut()).await;
    Ok(Json(page))
}

/// One library (a top bar tab), laid out like a genre page and named after it. Not found
/// for a library the account may not see.
async fn library_page(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<Json<GenrePage>> {
    let allowed = allowed_libraries(&state, me.user.id).await?;
    if allowed.as_ref().is_some_and(|a| !a.contains(&id)) {
        return Err(ApiError::NotFound);
    }
    let library = state.db.libraries().await?.into_iter().find(|l| l.id == id).ok_or(ApiError::NotFound)?;
    let (movies, shows) = if library.kind == "shows" {
        (Vec::new(), crate::catalog::series(&state, Some(&[id])).await?)
    } else {
        (movie_titles(&state, me.user.id, Some(id)).await?, Vec::new())
    };
    let mut page =
        build(None, &movies, &shows, featured::daily_seed(now(), me.user.id)).ok_or(ApiError::NotFound)?;
    page.name = library.name;
    add_logos(&state, page.featured.iter_mut()).await;
    Ok(Json(page))
}

/// Every movie (or show) the account may see, laid out like a genre page.
async fn kind_page(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(kind): Path<String>,
) -> ApiResult<Json<GenrePage>> {
    let (movies, shows) = match kind.as_str() {
        "movies" => (movie_titles(&state, me.user.id, None).await?, Vec::new()),
        "shows" => {
            let allowed = allowed_libraries(&state, me.user.id).await?;
            (Vec::new(), crate::catalog::series(&state, allowed.as_deref()).await?)
        }
        _ => return Err(ApiError::NotFound),
    };
    let mut page =
        build(None, &movies, &shows, featured::daily_seed(now(), me.user.id)).ok_or(ApiError::NotFound)?;
    add_logos(&state, page.featured.iter_mut()).await;
    Ok(Json(page))
}

/// The page for genre `name` from these titles, or for all of them (`name` unset: the Movies or
/// Shows page, by which are given). `None`: no titles. `seed` varies the featured picks from
/// day to day.
fn build(name: Option<&str>, movies: &[Title], shows: &[SeriesSummary], seed: u64) -> Option<GenrePage> {
    let is_name = |g: &str| name.is_some_and(|n| g.eq_ignore_ascii_case(n));
    let has = |g: Option<&str>| name.is_none() || genres_of(g).any(is_name);
    let mut entries: Vec<Entry> = movies
        .iter()
        .filter(|m| has(m.genres.as_deref()))
        .map(|m| Entry {
            spot: movie_spot(m, "Top rated", None),
            rating: m.rating.unwrap_or(0.0),
            added_at: &m.added_at,
            genres: genres_of(m.genres.as_deref()).collect(),
        })
        .collect();
    let movie_count = entries.len();
    entries.extend(shows.iter().filter(|s| has(s.genres.as_deref())).map(|s| Entry {
        spot: show_spot(s, "Top rated"),
        rating: s.rating.unwrap_or(0.0),
        added_at: &s.latest_added_at,
        genres: genres_of(s.genres.as_deref()).collect(),
    }));
    if entries.is_empty() {
        return None;
    }
    // The genre's own spelling, from the titles.
    let kind = if movie_count * 2 >= entries.len() { "movies" } else { "shows" };
    let shown_name = match name {
        Some(n) => entries[0].genres.iter().find(|g| is_name(g)).map_or(n, |g| *g),
        None => kind,
    };

    let by_rating = {
        let mut v: Vec<&Entry> = entries.iter().filter(|e| e.rating > 0.0).collect();
        v.sort_by(|a, b| b.rating.total_cmp(&a.rating));
        v
    };
    let by_added = {
        let mut v: Vec<&Entry> = entries.iter().collect();
        v.sort_by(|a, b| b.added_at.cmp(a.added_at));
        v
    };

    // Featured: a daily pick among the newest and among the best rated, with art.
    let mut rng = Rng::new(seed ^ 0x6e72);
    let with_art = |v: &[&Entry]| -> Vec<Spot> {
        v.iter().filter(|e| e.spot.backdrop.is_some()).take(FEATURED * 2).map(|e| e.spot.clone()).collect()
    };
    let mut newest = with_art(&by_added);
    let mut best = with_art(&by_rating);
    rng.shuffle(&mut newest);
    rng.shuffle(&mut best);
    let mut featured: Vec<Spot> = Vec::new();
    let picks = newest
        .into_iter()
        .take(FEATURED / 2)
        .map(|s| ("Recently added", s))
        .chain(best.into_iter().map(|s| ("Top rated", s)));
    for (reason, mut s) in picks {
        if featured.len() == FEATURED {
            break;
        }
        if featured.iter().any(|f| f.kind == s.kind && f.id == s.id) {
            continue;
        }
        s.reason = reason;
        featured.push(s);
    }

    // The banner: the best rated backdrop not already featured.
    let backdrop = by_rating
        .iter()
        .find(|e| {
            e.spot.backdrop.is_some() && !featured.iter().any(|f| f.kind == e.spot.kind && f.id == e.spot.id)
        })
        .or_else(|| by_rating.first())
        .and_then(|e| e.spot.backdrop.clone());

    let top: Vec<Spot> = by_rating.iter().take(TOP).map(|e| e.spot.clone()).collect();
    let recent: Vec<Spot> = by_added.iter().take(ROW).map(|e| e.spot.clone()).collect();

    let rows = if name.is_some() { PAIRED_ROWS } else { KIND_ROWS };
    let paired = genre_rows(&entries, &by_rating, &by_added, &is_name, rows);

    Some(GenrePage {
        name: shown_name.to_string(),
        backdrop,
        kind,
        count: entries.len(),
        featured,
        top,
        recent,
        paired,
    })
}

/// The genres most common among `entries` (minus the page's own), each a row of up to [`ROW`]
/// titles, best rated first and then unrated ones by when they were added.
fn genre_rows(
    entries: &[Entry],
    by_rating: &[&Entry],
    by_added: &[&Entry],
    is_name: &dyn Fn(&str) -> bool,
    rows: usize,
) -> Vec<PairedRow> {
    let mut pairs: HashMap<&str, usize> = HashMap::new();
    for e in entries {
        for g in e.genres.iter().filter(|g| !is_name(g)) {
            *pairs.entry(g).or_default() += 1;
        }
    }
    let mut pairs: Vec<(&str, usize)> = pairs.into_iter().filter(|(_, n)| *n >= PAIRED_MIN).collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    pairs
        .into_iter()
        .take(rows)
        .map(|(g, _)| PairedRow {
            genre: g.to_string(),
            items: by_rating
                .iter()
                .chain(by_added.iter().filter(|e| e.rating <= 0.0))
                .filter(|e| e.genres.contains(&g))
                .take(ROW)
                .map(|e| e.spot.clone())
                .collect(),
        })
        .collect()
}
