//! The home screen's hero: a varied, daily-rotating mix of movies and shows.
//!
//! Slides alternate between a few "reasons" (recently added, new release, top rated, a pick
//! from the library) so the hero isn't just the newest movies. Rotating picks are seeded by
//! the day and the user, so the hero changes daily, differs per profile, and stays the same
//! across refreshes within a day.

use std::collections::{HashMap, HashSet};

use panda_db::{ItemFilter, ItemKind, SeriesSummary, WatchState};
use serde::Serialize;

use super::titles::Title;
use super::watch::watch_key;
use crate::error::ApiResult;
use crate::state::AppState;

/// Slides in the hero.
pub(super) const FEATURED_LIMIT: usize = 8;
/// "Top rated" means at least this TMDB score.
const TOP_RATED: f64 = 7.5;
/// "New release": released this year or within this many years before it.
const NEW_RELEASE_YEARS: i64 = 1;

/// Why a slide is in the hero (shown above its title).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(super) enum Reason {
    #[serde(rename = "Recently added")]
    RecentlyAdded,
    #[serde(rename = "New release")]
    NewRelease,
    #[serde(rename = "Top rated")]
    TopRated,
    #[serde(rename = "From your library")]
    FromLibrary,
}

/// What to play for a featured show: the episode in progress, else the first unwatched one.
#[derive(Debug, Clone, Serialize)]
pub(super) struct NextEpisode {
    pub item_id: i64,
    pub season: i64,
    pub episode: i64,
    /// Resume point (0 = from the start).
    pub position_secs: f64,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FeaturedSeries {
    #[serde(flatten)]
    pub summary: SeriesSummary,
    pub next: Option<NextEpisode>,
}

/// One hero slide: exactly one of `movie` / `series` is set.
#[derive(Debug, Clone, Serialize)]
pub(super) struct Featured {
    pub reason: Reason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub movie: Option<Title>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<FeaturedSeries>,
    /// The title's logo (image key), when one is already known (never waited for here).
    pub logo: Option<String>,
    /// Its ratings, TMDB's first, as title pages show them.
    pub ratings: Vec<crate::services::providers::Rating>,
}

/// A slide before it's resolved into data: an index into the movies or shows given to [`pick`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Pick {
    Movie(usize),
    Show(usize),
}

/// Small deterministic PRNG (xorshift64*): rotation only needs to be stable per day and user.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Fisher-Yates.
    pub(super) fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            #[allow(clippy::cast_possible_truncation)] // the modulo keeps it below `i + 1`
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

/// Seed for today's rotation: changes daily, differs per user.
pub(super) fn daily_seed(now_secs: i64, user_id: i64) -> u64 {
    #[allow(clippy::cast_sign_loss)]
    let day = (now_secs / 86_400).max(0) as u64;
    #[allow(clippy::cast_sign_loss)]
    let user = user_id.max(0) as u64;
    day.wrapping_mul(1_000_003).wrapping_add(user)
}

/// Choose the hero's slides. `movies` and `shows` can be in any order; only entries with a
/// backdrop are eligible, and finished movies are skipped. Slides cycle through the reasons
/// (each pool skipped once it runs out) and never repeat a title.
pub(super) fn pick(
    movies: &[Title],
    shows: &[SeriesSummary],
    this_year: i64,
    seed: u64,
) -> Vec<(Reason, Pick)> {
    let mut rng = Rng::new(seed);
    let movie_ok = |m: &Title| m.backdrop.is_some() && !m.progress.as_ref().is_some_and(|p| p.finished);
    let movie_ids: Vec<usize> = (0..movies.len()).filter(|&i| movie_ok(&movies[i])).collect();
    let show_ids: Vec<usize> = (0..shows.len()).filter(|&i| shows[i].backdrop.is_some()).collect();

    let mut new_movies = movie_ids.clone();
    new_movies.sort_by(|&a, &b| movies[b].added_at.cmp(&movies[a].added_at));
    let mut new_shows = show_ids.clone();
    new_shows.sort_by(|&a, &b| shows[b].latest_added_at.cmp(&shows[a].latest_added_at));

    // Newest releases first; only recent years count as "new".
    let mut releases: Vec<usize> = movie_ids
        .iter()
        .copied()
        .filter(|&i| movies[i].year.is_some_and(|y| y >= this_year - NEW_RELEASE_YEARS))
        .collect();
    releases.sort_by(|&a, &b| {
        movies[b].year.cmp(&movies[a].year).then(movies[b].added_at.cmp(&movies[a].added_at))
    });

    // Rotating pools: shuffled with today's seed.
    let mut top: Vec<Pick> = movie_ids
        .iter()
        .filter(|&&i| movies[i].rating.is_some_and(|r| r >= TOP_RATED))
        .map(|&i| Pick::Movie(i))
        .chain(
            show_ids
                .iter()
                .filter(|&&i| shows[i].rating.is_some_and(|r| r >= TOP_RATED))
                .map(|&i| Pick::Show(i)),
        )
        .collect();
    rng.shuffle(&mut top);
    let mut library: Vec<Pick> =
        movie_ids.iter().map(|&i| Pick::Movie(i)).chain(show_ids.iter().map(|&i| Pick::Show(i))).collect();
    rng.shuffle(&mut library);

    let mut pools: Vec<(Reason, std::vec::IntoIter<Pick>)> = vec![
        (Reason::RecentlyAdded, new_movies.into_iter().map(Pick::Movie).collect::<Vec<_>>().into_iter()),
        (Reason::RecentlyAdded, new_shows.into_iter().map(Pick::Show).collect::<Vec<_>>().into_iter()),
        (Reason::NewRelease, releases.into_iter().map(Pick::Movie).collect::<Vec<_>>().into_iter()),
        (Reason::TopRated, top.into_iter()),
        (Reason::FromLibrary, library.into_iter()),
    ];

    let mut out: Vec<(Reason, Pick)> = Vec::new();
    let mut used: HashSet<Pick> = HashSet::new();
    // Round-robin over the pools until full or every pool is empty.
    while out.len() < FEATURED_LIMIT {
        let mut progressed = false;
        for (reason, pool) in &mut pools {
            if out.len() >= FEATURED_LIMIT {
                break;
            }
            if let Some(p) = pool.find(|p| !used.contains(p)) {
                used.insert(p);
                out.push((*reason, p));
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    out
}

/// The episode to play for a featured show: the one in progress, else the first not finished,
/// else the first (rewatch).
pub(super) async fn next_episode(
    state: &AppState,
    series: &str,
    access: &crate::auth::Access,
    watched: &HashMap<String, WatchState>,
) -> ApiResult<Option<NextEpisode>> {
    let filter = access.filter(ItemFilter {
        series: Some(series.to_string()),
        kind: Some(ItemKind::Episode),
        limit: Some(10_000),
        ..Default::default()
    });
    let mut episodes = state.db.items(&filter).await?; // season/episode order
    // Specials (season 0) last: an unwatched show starts at S01E01, not a bonus episode.
    episodes.sort_by_key(|e| (e.season.unwrap_or(0) < 1, e.season, e.episode));
    let state_of = |e: &panda_db::Item| watched.get(&watch_key(e));
    let chosen = episodes
        .iter()
        .find(|e| state_of(e).is_some_and(WatchState::in_progress))
        .or_else(|| episodes.iter().find(|e| !state_of(e).is_some_and(|w| w.finished)))
        .or_else(|| episodes.first());
    Ok(chosen.map(|e| NextEpisode {
        item_id: e.id,
        season: e.season.unwrap_or(0),
        episode: e.episode.unwrap_or(0),
        position_secs: state_of(e).filter(|w| w.in_progress()).map_or(0.0, |w| w.position_secs),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn movie(id: &str, added: &str, year: i64, rating: f64) -> Title {
        Title {
            id: id.into(),
            kind: "movie",
            library_id: 1,
            title: id.into(),
            year: Some(year),
            overview: None,
            genres: None,
            rating: Some(rating),
            poster: None,
            backdrop: Some("b".into()),
            duration_secs: None,
            added_at: added.into(),
            versions: vec![],
            progress: None,
            rating_age: None,
        }
    }

    fn show(name: &str, added: &str, rating: f64) -> SeriesSummary {
        SeriesSummary {
            series: name.into(),
            library_id: 2,
            episodes: 10,
            seasons: 1,
            tmdb_id: None,
            meta_title: None,
            year: Some(2020),
            overview: None,
            genres: None,
            rating: Some(rating),
            poster: None,
            backdrop: Some("b".into()),
            latest_added_at: added.into(),
            rating_age: None,
        }
    }

    fn library() -> (Vec<Title>, Vec<SeriesSummary>) {
        let movies = vec![
            movie("old-classic", "2026-01-01", 1977, 8.6),
            movie("newest-added", "2026-11-19", 2001, 6.0),
            movie("fresh-release", "2026-03-01", 2026, 6.8),
            movie("mid", "2026-06-01", 2010, 7.0),
            movie("great", "2026-02-01", 1994, 9.0),
        ];
        let shows = vec![show("new-show", "2026-11-18", 7.0), show("acclaimed", "2025-01-01", 8.8)];
        (movies, shows)
    }

    #[test]
    fn mixes_movies_shows_and_reasons_without_repeats() {
        let (movies, shows) = library();
        let picks = pick(&movies, &shows, 2026, 42);
        // Opens with the newest movie, then the newest show, then a new release.
        assert_eq!(picks[0], (Reason::RecentlyAdded, Pick::Movie(1)));
        assert_eq!(picks[1], (Reason::RecentlyAdded, Pick::Show(0)));
        assert_eq!(picks[2], (Reason::NewRelease, Pick::Movie(2)));
        assert!(picks.iter().any(|(r, _)| *r == Reason::TopRated));
        assert!(picks.iter().any(|(_, p)| matches!(p, Pick::Show(_))));
        let unique: HashSet<_> = picks.iter().map(|(_, p)| *p).collect();
        assert_eq!(unique.len(), picks.len(), "no title twice: {picks:?}");
        // Everything eligible fits (7 titles < 8 slides).
        assert_eq!(picks.len(), movies.len() + shows.len());
    }

    #[test]
    fn skips_titles_without_backdrops_and_finished_movies() {
        let (mut movies, shows) = library();
        movies[1].backdrop = None;
        movies[4].progress = Some(super::super::watch::Progress {
            position_secs: 0.0,
            duration_secs: None,
            finished: true,
            fraction: 0.0,
            last_played_at: 0,
        });
        let picks = pick(&movies, &shows, 2026, 1);
        assert!(!picks.iter().any(|(_, p)| matches!(p, Pick::Movie(1 | 4))), "{picks:?}");
    }

    #[test]
    fn rotation_is_stable_within_a_day_and_changes_across_days() {
        let movies: Vec<Title> = (0..40)
            .map(|i| movie(&format!("m{i}"), &format!("2026-01-{:02}", i % 28 + 1), 2000, 8.0))
            .collect();
        let day = 1_795_000_000;
        let a = pick(&movies, &[], 2026, daily_seed(day, 7));
        let b = pick(&movies, &[], 2026, daily_seed(day + 60, 7));
        assert_eq!(a, b, "same day, same hero");
        let c = pick(&movies, &[], 2026, daily_seed(day + 86_400, 7));
        assert_ne!(a, c, "the rotating slides change the next day");
        let d = pick(&movies, &[], 2026, daily_seed(day, 8));
        assert_ne!(a, d, "and differ per user");
    }

    #[test]
    fn empty_library_has_no_slides() {
        assert!(pick(&[], &[], 2026, 1).is_empty());
    }
}
