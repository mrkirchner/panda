//! The library catalog in memory: every movie grouped into titles, and every show, built once
//! and shared by all requests (Home, title pages, search, suggestions, Top Shelf...), instead of
//! each request decoding and grouping the whole library again (~30 ms at 5,000 movies).
//!
//! Requests add only what's theirs: library access and the profile's progress. It rebuilds when
//! the database's catalog version moves (triggers bump it on any shown change to items,
//! metadata, episodes or libraries, whatever wrote it); checking that costs one tiny query.

use std::collections::HashMap;
use std::sync::Arc;

use panda_db::{ItemFilter, ItemKind, SeriesSummary};
use tokio::sync::Mutex;

use crate::error::ApiResult;
use crate::routes::{Title, group_movies, watch_key};
use crate::state::AppState;

/// A movie title as cached: progress is per profile, so it's left out; each version's library
/// (for access filtering) and watch key (for progress) sit beside it.
#[derive(Debug)]
pub(crate) struct CatalogTitle {
    pub title: Title,
    /// Library of each version, in `title.versions` order.
    pub libraries: Vec<i64>,
    /// Watch key of each version, in `title.versions` order.
    pub keys: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Catalog {
    /// Sorted by title.
    pub movies: Vec<CatalogTitle>,
    pub series: Vec<SeriesSummary>,
    /// The database's catalog version it was built at.
    version: i64,
}

/// The server's current catalog (in `AppState`); the lock also makes concurrent rebuilds wait
/// for one.
pub(crate) type CatalogCell = Mutex<Option<Arc<Catalog>>>;

/// The catalog, rebuilt when the database's catalog version has moved.
pub(crate) async fn get(state: &AppState) -> ApiResult<Arc<Catalog>> {
    let version = state.db.catalog_version().await?;
    let mut current = state.catalog.lock().await;
    if let Some(c) = current.as_ref()
        && c.version == version
    {
        return Ok(c.clone());
    }
    let built = Arc::new(build(state, version).await?);
    *current = Some(built.clone());
    Ok(built)
}

async fn build(state: &AppState, version: i64) -> ApiResult<Catalog> {
    let filter = ItemFilter { kind: Some(ItemKind::Movie), limit: Some(10_000), ..Default::default() };
    let items = state.db.items(&filter).await?;
    let by_id: HashMap<i64, (i64, String)> =
        items.iter().map(|i| (i.id, (i.library_id, watch_key(i)))).collect();
    let movies = group_movies(items)
        .into_iter()
        .map(|title| {
            let (libraries, keys) = title
                .versions
                .iter()
                .map(|v| by_id.get(&v.item_id).cloned().unwrap_or((title.library_id, String::new())))
                .unzip();
            CatalogTitle { title, libraries, keys }
        })
        .collect();
    let series = state.db.series().await?;
    Ok(Catalog { movies, series, version })
}

/// Every show visible with `allowed` (`None` = all libraries).
pub(crate) async fn series(state: &AppState, allowed: Option<&[i64]>) -> ApiResult<Vec<SeriesSummary>> {
    let catalog = get(state).await?;
    Ok(catalog.series.iter().filter(|s| allowed.is_none_or(|a| a.contains(&s.library_id))).cloned().collect())
}

/// The show a series name refers to, whichever of its folders' spellings it is: exactly, ignoring
/// case, or through the TMDB show that folder matched (two folders of one show are one show).
pub(crate) async fn find_series(
    state: &AppState,
    allowed: Option<&[i64]>,
    name: &str,
) -> ApiResult<Option<SeriesSummary>> {
    let shows = series(state, allowed).await?;
    if let Some(s) = shows.iter().find(|s| s.series == name || s.series.eq_ignore_ascii_case(name)) {
        return Ok(Some(s.clone()));
    }
    let Some(tmdb) = state.db.series_tmdb_id(name).await? else { return Ok(None) };
    Ok(shows.into_iter().find(|s| s.tmdb_id == Some(tmdb)))
}
