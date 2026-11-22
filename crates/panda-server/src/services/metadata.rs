//! Match library items to TMDB and cache their artwork. Runs after every scan.
//!
//! Only items without metadata are looked up, and failed matches are retried weekly, so a
//! steady-state scan makes zero TMDB requests. Images are downloaded once (see `ImageCache`).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use panda_db::{Item, MetadataKind, NewEpisode, NewMetadata, PendingEpisode, ShownEpisode};
use panda_metadata::tmdb::ExternalIds;
use panda_metadata::{ImageCache, ImageSize, Tmdb, matching};
use tokio::task::JoinSet;

use crate::services::providers;
use crate::state::AppState;

/// Titles matched concurrently. The TMDB client also caps in-flight requests itself.
const CONCURRENCY: usize = 6;

pub(crate) async fn enrich(state: &AppState) {
    let Some(tmdb) = state.integrations().tmdb.clone() else { return };
    let started = std::time::Instant::now();
    if let Err(e) = unmatch_wrong_years(state).await {
        tracing::warn!(error = %e, "checking show matches against folder years failed");
    }
    let (movies, series) = tokio::join!(enrich_movies(state, &tmdb), enrich_series(state, &tmdb));
    match (movies, series) {
        (Ok((mm, mu)), Ok((sm, su))) => tracing::info!(
            movies_matched = mm,
            movies_unmatched = mu,
            series_matched = sm,
            series_unmatched = su,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "metadata pass complete"
        ),
        (Err(e), _) | (_, Err(e)) => tracing::error!(error = %e, "metadata pass failed"),
    }
    // In the background: a scan (holding the scan lock) mustn't wait for lookups at other
    // services. Passes run one at a time on their own.
    providers::refresh_soon(state);
}

/// Save a title's TMDB details, recording TMDB's plot as its answer (another provider may be
/// shown instead, by the admin's order).
/// Its plot and artwork are picked here (episodes come with `store_episodes`). Its ids
/// elsewhere are kept, for the extra providers.
async fn save_metadata(state: &AppState, m: &Matched) -> anyhow::Result<i64> {
    let meta = &m.meta;
    let id = state.db.upsert_metadata(meta).await?;
    state.db.set_title_ids(id, m.ids.imdb_id.as_deref(), m.ids.tvdb_id).await?;
    providers::record_tmdb_title(state, id, meta).await?;
    providers::apply(state, id, Some(&BTreeSet::new())).await?;
    Ok(id)
}

/// The episode order (TMDB episode group) a show is numbered by: chosen for the show, so any
/// of its folders (an HD and a 4K one, say) carries it; `folder` first.
pub(crate) async fn show_episode_order(
    state: &AppState,
    metadata_id: i64,
    folder: &str,
) -> panda_db::Result<Option<String>> {
    if let Some(order) = state.db.episode_order(&matching::normalize(folder)).await? {
        return Ok(Some(order));
    }
    for f in state.db.metadata_folders(metadata_id).await? {
        if let Some(order) = state.db.episode_order(&matching::normalize(&f)).await? {
            return Ok(Some(order));
        }
    }
    Ok(None)
}

/// One TMDB episode, ready to store.
fn new_episode(
    season: i64,
    episode: i64,
    name: Option<String>,
    overview: Option<String>,
    air_date: Option<String>,
    still: Option<String>,
) -> NewEpisode {
    NewEpisode { season, episode, name, overview: overview.filter(|o| !o.is_empty()), air_date, still }
}

/// Show folders whose name has a year (`Monster (2022)`) that its match contradicts (matched
/// before years counted, or a wrong pick) are unmatched, so this pass matches them again with
/// the year. A match fixed by hand is left alone.
async fn unmatch_wrong_years(state: &AppState) -> anyhow::Result<()> {
    for f in state.db.series_folders().await? {
        let (Some(want), Some(got)) = (matching::folder_year(&f.series), f.year) else { continue };
        if (i64::from(want) - got).abs() <= 1 {
            continue;
        }
        if state.db.match_override(MetadataKind::Series, &matching::normalize(&f.series)).await?.is_some() {
            continue;
        }
        let n = state.db.clear_series_match(&f.series).await?;
        tracing::info!(series = %f.series, matched_year = got, episodes = n, "show matched a different year; matching again");
    }
    Ok(())
}

/// A title's TMDB details, ready to store, with its ids elsewhere (TVDB, `IMDb`).
pub(crate) struct Matched {
    pub meta: NewMetadata,
    pub ids: ExternalIds,
}

/// Group pending items by (title, year) so 4K + HD copies cost one lookup.
async fn enrich_movies(state: &AppState, tmdb: &Arc<Tmdb>) -> anyhow::Result<(usize, usize)> {
    let mut groups: HashMap<(String, Option<i64>), Vec<i64>> = HashMap::new();
    for p in state.db.pending_movies().await? {
        groups.entry((p.title, p.year)).or_default().push(p.id);
    }

    // Movies asked for through Panda: their TMDB id is already known (Radarr can name a folder
    // by another year than TMDB's: `The Loud House Movie (2026)` for 2021's).
    let requested: Arc<Vec<(String, Option<i64>, i64)>> = Arc::new(
        state
            .db
            .requests()
            .await?
            .into_iter()
            .filter(|r| r.kind == panda_db::RequestKind::Movie)
            .filter_map(|r| Some((matching::normalize(&r.title), r.year, r.tmdb_id?)))
            .collect(),
    );

    let mut set = JoinSet::new();
    let (mut matched, mut unmatched) = (0, 0);
    for ((title, year), ids) in groups {
        if set.len() >= CONCURRENCY
            && let Some(r) = set.join_next().await
        {
            tally(r, &mut matched, &mut unmatched);
        }
        let (state, tmdb, requested) = (state.clone(), tmdb.clone(), requested.clone());
        set.spawn(async move {
            // A name matched by hand before (an upgrade or rename made a new file): reuse it.
            // Else a movie requested by that very name; else TMDB search.
            let by_hand = state.db.match_override(MetadataKind::Movie, &matching::normalize(&title)).await?;
            let found = match by_hand.or_else(|| requested_movie(&requested, &title, year)) {
                Some(id) => movie_metadata(&tmdb, &state.images, id).await.map(Some),
                None => match_movie(&tmdb, &state.images, &title, year).await,
            };
            let meta_id = match found {
                Ok(Some(m)) => Some(save_metadata(&state, &m).await?),
                Ok(None) => {
                    tracing::info!(%title, ?year, "no TMDB match for movie");
                    None
                }
                Err(e) => {
                    // Network/API errors aren't recorded as attempts, so the next scan retries.
                    tracing::warn!(%title, error = %e, "TMDB lookup failed");
                    return Ok(false);
                }
            };
            state.db.set_item_metadata(&ids, meta_id).await?;
            Ok::<_, anyhow::Error>(meta_id.is_some())
        });
    }
    while let Some(r) = set.join_next().await {
        tally(r, &mut matched, &mut unmatched);
    }
    Ok((matched, unmatched))
}

async fn enrich_series(state: &AppState, tmdb: &Arc<Tmdb>) -> anyhow::Result<(usize, usize)> {
    let mut groups: HashMap<String, (Vec<PendingEpisode>, BTreeSet<i64>)> = HashMap::new();
    for p in state.db.pending_episodes().await? {
        let g = groups.entry(p.series.clone()).or_default();
        g.1.insert(p.season);
        g.0.push(p);
    }

    let mut set = JoinSet::new();
    let (mut matched, mut unmatched) = (0, 0);
    for (name, (pending, seasons)) in groups {
        if set.len() >= CONCURRENCY
            && let Some(r) = set.join_next().await
        {
            tally(r, &mut matched, &mut unmatched);
        }
        let (state, tmdb) = (state.clone(), tmdb.clone());
        set.spawn(async move {
            let found =
                match state.db.match_override(MetadataKind::Series, &matching::normalize(&name)).await? {
                    Some(id) => series_metadata(&tmdb, &state.images, id).await.map(|m| Some((m, id))),
                    None => match_series(&tmdb, &state.images, &name).await,
                };
            let meta_id = match found {
                Ok(Some((meta, tmdb_id))) => {
                    let id = save_metadata(&state, &meta).await?;
                    let episodes = store_episodes(&state, &tmdb, tmdb_id, id, &name, &seasons).await?;
                    number_by_title(&state, &pending, &episodes).await?;
                    Some(id)
                }
                Ok(None) => {
                    tracing::info!(series = %name, "no TMDB match for series");
                    None
                }
                Err(e) => {
                    tracing::warn!(series = %name, error = %e, "TMDB lookup failed");
                    return Ok(false);
                }
            };
            let ids: Vec<i64> = pending.iter().map(|p| p.id).collect();
            state.db.set_item_metadata(&ids, meta_id).await?;
            Ok::<_, anyhow::Error>(meta_id.is_some())
        });
    }
    while let Some(r) = set.join_next().await {
        tally(r, &mut matched, &mut unmatched);
    }
    Ok((matched, unmatched))
}

/// Title-only files (`Season 1/Twiggy.m4v`) get their episode number from TMDB's episode names.
async fn number_by_title(
    state: &AppState,
    pending: &[PendingEpisode],
    episodes: &[ShownEpisode],
) -> anyhow::Result<()> {
    for p in pending.iter().filter(|p| p.episode.is_none()) {
        let want = matching::normalize(&p.title);
        let found = episodes.iter().filter(|e| e.season == p.season).find(|e| {
            e.name
                .as_deref()
                .map(matching::normalize)
                .is_some_and(|n| n == want || n.contains(&want) || want.contains(&n))
        });
        if let Some(e) = found {
            state.db.set_item_episode(p.id, e.episode).await?;
        } else {
            tracing::debug!(title = %p.title, season = p.season, "no TMDB episode with this name");
        }
    }
    Ok(())
}

fn tally(
    r: Result<anyhow::Result<bool>, tokio::task::JoinError>,
    matched: &mut usize,
    unmatched: &mut usize,
) {
    match r {
        Ok(Ok(true)) => *matched += 1,
        Ok(Ok(false)) => *unmatched += 1,
        Ok(Err(e)) => tracing::error!(error = %e, "saving metadata failed"),
        Err(e) => tracing::error!(error = %e, "metadata task panicked"),
    }
}

fn year(date: Option<&str>) -> Option<i64> {
    date.and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
}

fn genres(g: &[panda_metadata::tmdb::Genre]) -> Option<String> {
    (!g.is_empty()).then(|| g.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "))
}

async fn image(tmdb: &Tmdb, cache: &ImageCache, size: ImageSize, path: Option<&str>) -> Option<String> {
    let path = path?;
    match cache.fetch(tmdb, size, path).await {
        Ok(key) => key,
        Err(e) => {
            tracing::warn!(path, error = %e, "image download failed");
            None
        }
    }
}

/// The TMDB id of a requested movie with exactly this name: the one of that year when several
/// share it, else the only one.
fn requested_movie(requested: &[(String, Option<i64>, i64)], title: &str, year: Option<i64>) -> Option<i64> {
    let name = matching::normalize(title);
    let same: Vec<_> = requested.iter().filter(|(n, _, _)| *n == name).collect();
    same.iter()
        .find(|(_, y, _)| year.is_some() && *y == year)
        .or_else(|| (same.len() == 1).then(|| &same[0]))
        .map(|(_, _, id)| *id)
}

async fn match_movie(
    tmdb: &Tmdb,
    cache: &ImageCache,
    title: &str,
    year_hint: Option<i64>,
) -> panda_metadata::Result<Option<Matched>> {
    let year_hint = year_hint.and_then(|y| u16::try_from(y).ok());
    let mut hit = None;
    'search: for query in matching::query_variants(title) {
        // With the year first (precise), then without (release-year mismatches across regions).
        for y in [year_hint, None] {
            let results = tmdb.search_movie(&query, y).await?;
            if let Some(m) = matching::best_movie(&query, year_hint, &results) {
                hit = Some(m.id);
                break 'search;
            }
            if year_hint.is_none() {
                break;
            }
        }
    }
    let Some(id) = hit else { return Ok(None) };
    movie_metadata(tmdb, cache, id).await.map(Some)
}

/// A movie's details from TMDB (and its artwork, cached), ready to store.
pub(crate) async fn movie_metadata(
    tmdb: &Tmdb,
    cache: &ImageCache,
    id: i64,
) -> panda_metadata::Result<Matched> {
    let d = tmdb.movie(id).await?;
    let (poster, backdrop) = tokio::join!(
        image(tmdb, cache, ImageSize::Poster, d.poster_path.as_deref()),
        image(tmdb, cache, ImageSize::Backdrop, d.backdrop_path.as_deref()),
    );
    let ids = d.external_ids.clone();
    let meta = NewMetadata {
        kind: MetadataKind::Movie,
        tmdb_id: d.id,
        year: year(d.release_date.as_deref()),
        genres: genres(&d.genres),
        title: d.title,
        original_title: d.original_title,
        overview: d.overview.filter(|o| !o.is_empty()),
        tagline: d.tagline.filter(|t| !t.is_empty()),
        runtime_mins: d.runtime,
        rating: d.vote_average,
        poster,
        backdrop,
    };
    Ok(Matched { meta, ids })
}

async fn match_series(
    tmdb: &Tmdb,
    cache: &ImageCache,
    name: &str,
) -> panda_metadata::Result<Option<(Matched, i64)>> {
    // A folder's year (`Monster (2022)`) tells shows of one name apart: search that year first,
    // and never take a show from another year.
    let year = matching::folder_year(name);
    let mut hit = None;
    'queries: for query in matching::query_variants(name) {
        let years = if year.is_some() { vec![year, None] } else { vec![None] };
        for filter in years {
            let results = tmdb.search_tv(&query, filter).await?;
            if let Some(t) = matching::best_tv(&query, year, &results) {
                hit = Some(t.id);
                break 'queries;
            }
        }
    }
    let Some(id) = hit else { return Ok(None) };
    series_metadata(tmdb, cache, id).await.map(|m| Some((m, id)))
}

/// A show's details from TMDB (and its artwork, cached), ready to store.
pub(crate) async fn series_metadata(
    tmdb: &Tmdb,
    cache: &ImageCache,
    id: i64,
) -> panda_metadata::Result<Matched> {
    let d = tmdb.tv(id).await?;
    let (poster, backdrop) = tokio::join!(
        image(tmdb, cache, ImageSize::Poster, d.poster_path.as_deref()),
        image(tmdb, cache, ImageSize::Backdrop, d.backdrop_path.as_deref()),
    );
    let ids = d.external_ids.clone();
    let meta = NewMetadata {
        kind: MetadataKind::Series,
        tmdb_id: d.id,
        year: year(d.first_air_date.as_deref()),
        genres: genres(&d.genres),
        title: d.name,
        original_title: d.original_name,
        overview: d.overview.filter(|o| !o.is_empty()),
        tagline: d.tagline.filter(|t| !t.is_empty()),
        runtime_mins: None,
        rating: d.vote_average,
        poster,
        backdrop,
    };
    Ok(Matched { meta, ids })
}

/// Match these movie files to TMDB movie `tmdb_id` by hand (fixing a wrong or missing match).
/// Scans never re-match a file that has a match, so it sticks.
pub(crate) async fn apply_movie(state: &AppState, item_ids: &[i64], tmdb_id: i64) -> anyhow::Result<()> {
    let tmdb = state.integrations().tmdb.clone().ok_or_else(|| anyhow::anyhow!("TMDB isn't set up"))?;
    let id = save_metadata(state, &movie_metadata(&tmdb, &state.images, tmdb_id).await?).await?;
    state.db.set_item_metadata(item_ids, Some(id)).await?;
    // Remembered by name, so a new file of this movie (an upgrade) gets the same match.
    let now = crate::services::settings::now();
    for item in state.db.items_by_ids(item_ids).await? {
        state
            .db
            .set_match_override(MetadataKind::Movie, &matching::normalize(&item.title), tmdb_id, now)
            .await?;
    }
    Ok(())
}

/// Match these episode files (one show, every folder of it) to TMDB show `tmdb_id` by hand:
/// its details, artwork and episode names; title-only files get their numbers from it.
pub(crate) async fn apply_series(state: &AppState, items: &[Item], tmdb_id: i64) -> anyhow::Result<()> {
    let tmdb = state.integrations().tmdb.clone().ok_or_else(|| anyhow::anyhow!("TMDB isn't set up"))?;
    let id = save_metadata(state, &series_metadata(&tmdb, &state.images, tmdb_id).await?).await?;
    let seasons: BTreeSet<i64> = items.iter().filter_map(|i| i.season).collect();
    let folder = items.iter().find_map(|i| i.series.clone()).unwrap_or_default();
    let episodes = store_episodes(state, &tmdb, tmdb_id, id, &folder, &seasons).await?;
    let title_only: Vec<PendingEpisode> = items
        .iter()
        .filter(|i| i.episode.is_none())
        .map(|i| PendingEpisode {
            id: i.id,
            series: i.series.clone().unwrap_or_default(),
            season: i.season.unwrap_or(0),
            episode: None,
            title: i.title.clone(),
        })
        .collect();
    number_by_title(state, &title_only, &episodes).await?;
    let ids: Vec<i64> = items.iter().map(|i| i.id).collect();
    state.db.set_item_metadata(&ids, Some(id)).await?;
    // Remembered by folder name, so new episodes (and new folders of that name) match the same.
    let now = crate::services::settings::now();
    let names: BTreeSet<String> =
        items.iter().filter_map(|i| i.series.as_deref()).map(matching::normalize).collect();
    for name in names {
        state.db.set_match_override(MetadataKind::Series, &name, tmdb_id, now).await?;
    }
    Ok(())
}

/// Fetch and store a show's episodes for `seasons` (under its metadata row `metadata_id`): from
/// the show itself, except seasons of `folder` matched by hand to another TMDB show (an
/// anthology's story), which come from that show's season, numbered as the folder's season.
/// The episode providers (TVmaze) are asked about the show again in the next lookup pass; the
/// shown text is picked by the admin's provider order and returned. Stills come from TMDB.
pub(crate) async fn store_episodes(
    state: &AppState,
    tmdb: &Tmdb,
    show_tmdb_id: i64,
    metadata_id: i64,
    folder: &str,
    seasons: &BTreeSet<i64>,
) -> anyhow::Result<Vec<ShownEpisode>> {
    let mapped = state.db.season_matches(&matching::normalize(folder)).await?;
    let own: BTreeSet<i64> =
        seasons.iter().copied().filter(|s| !mapped.iter().any(|m| m.season == *s)).collect();
    // Numbered by another of TMDB's episode orders (DVD, absolute, ...) when one was chosen.
    let mut episodes = match show_episode_order(state, metadata_id, folder).await? {
        Some(group) => ordered_episodes(tmdb, &group, &own).await.unwrap_or_else(|e| {
            // Lookup failed: keep what's stored.
            tracing::warn!(group, error = %e, "episode order lookup failed");
            Vec::new()
        }),
        None => season_episodes(tmdb, show_tmdb_id, &own).await,
    };
    for m in mapped.iter().filter(|m| seasons.contains(&m.season)) {
        let from = season_episodes(tmdb, m.tmdb_id, &BTreeSet::from([m.tmdb_season])).await;
        if from.is_empty() {
            continue; // Lookup failed: keep what's stored.
        }
        // The show's own episodes of that season (if it has one) must not mix in.
        // (Every provider's answers about it go too.)
        state.db.clear_season_episodes(metadata_id, m.season).await?;
        episodes.extend(from.into_iter().map(|e| NewEpisode { season: m.season, ..e }));
    }
    state.db.upsert_episodes(metadata_id, &episodes).await?;
    providers::record_tmdb_episodes(state, metadata_id, &episodes).await?;
    providers::apply(state, metadata_id, Some(seasons)).await
}

/// The episodes of `seasons` in one of TMDB's episode orders: its parts numbered as seasons
/// (`EpisodeGroup::season_of`), their episodes from 1.
pub(crate) async fn ordered_episodes(
    tmdb: &Tmdb,
    group_id: &str,
    seasons: &BTreeSet<i64>,
) -> panda_metadata::Result<Vec<NewEpisode>> {
    let g = tmdb.episode_group(group_id).await?;
    Ok(g.groups
        .iter()
        .map(|part| (g.season_of(part), part))
        .filter(|(season, _)| seasons.contains(season))
        .flat_map(|(season, part)| {
            part.episodes.iter().map(move |e| {
                new_episode(
                    season,
                    e.order + 1,
                    e.name.clone(),
                    e.overview.clone(),
                    e.air_date.clone(),
                    e.still_path.clone(),
                )
            })
        })
        .collect())
}

async fn season_episodes(tmdb: &Tmdb, tv_id: i64, seasons: &BTreeSet<i64>) -> Vec<NewEpisode> {
    let mut out = Vec::new();
    for &s in seasons {
        match tmdb.season(tv_id, s).await {
            Ok(season) => out.extend(season.episodes.into_iter().map(|e| {
                new_episode(e.season_number, e.episode_number, e.name, e.overview, e.air_date, e.still_path)
            })),
            Err(e) => tracing::warn!(tv_id, season = s, error = %e, "season lookup failed"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_movies_match_by_name_whatever_the_folder_year() {
        let req = vec![
            ("the loud house movie".to_string(), Some(2021), 410_113),
            ("dune".to_string(), Some(1984), 841),
            ("dune".to_string(), Some(2021), 438_631),
        ];
        assert_eq!(requested_movie(&req, "The Loud House Movie", Some(2026)), Some(410_113));
        assert_eq!(
            requested_movie(&req, "Dune", Some(2021)),
            Some(438_631),
            "the year picks among namesakes"
        );
        assert_eq!(requested_movie(&req, "Dune", Some(2000)), None, "namesakes, no year to tell");
        assert_eq!(requested_movie(&req, "Heat", Some(1995)), None);
    }
}
