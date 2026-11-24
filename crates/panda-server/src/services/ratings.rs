//! Titles' age ratings, for profiles' age limits: every title in the library gets its rating
//! from TMDB for the server's region (else the US), as an age (`panda_metadata::ratings`).
//! Looked up in the background, a few at a time: new titles within a minute, all of them again
//! when the region changes, and each every 90 days (ratings do change).

use std::time::Duration;

use futures_util::StreamExt as _;

use crate::state::AppState;

/// How often to look for titles to rate when there were none.
const IDLE: Duration = Duration::from_secs(60);
/// Titles per batch, and TMDB requests at once (TMDB allows ~50 a second).
const BATCH: i64 = 40;
const AT_ONCE: usize = 4;
/// A rating is looked up again after this long.
const REFRESH_SECS: i64 = 90 * 24 * 3600;

/// The region ratings are read for (`[tmdb] region`, else the US).
pub(crate) fn region(state: &AppState) -> String {
    state.config.tmdb.region.clone().unwrap_or_else(|| "US".into()).to_uppercase()
}

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            match rate_some(&state).await {
                Ok(0) | Err(_) => tokio::time::sleep(IDLE).await,
                Ok(n) => tracing::debug!(rated = n, "looked up age ratings"),
            }
        }
    });
}

/// One batch; returns how many titles were looked up (0: none due, or no TMDB).
async fn rate_some(state: &AppState) -> anyhow::Result<usize> {
    let Some(tmdb) = state.integrations().tmdb.clone() else { return Ok(0) };
    let region = region(state);
    let now = crate::services::settings::now();
    let due = state.db.titles_to_rate(&region, now - REFRESH_SECS, BATCH).await?;
    if due.is_empty() {
        return Ok(0);
    }
    let n = due.len();
    let results: Vec<_> = futures_util::stream::iter(due)
        .map(|t| {
            let tmdb = tmdb.clone();
            let region = region.clone();
            async move {
                let rated = if t.kind == "movie" {
                    tmdb.release_dates(t.tmdb_id).await.map(|r| r.rated(&region))
                } else {
                    tmdb.content_ratings(t.tmdb_id).await.map(|r| r.rated(&region))
                };
                (t, rated)
            }
        })
        .buffer_unordered(AT_ONCE)
        .collect()
        .await;
    for (t, rated) in results {
        match rated {
            Ok(r) => {
                let (cert, age) = r.map_or((None, None), |(c, a)| (Some(c), Some(i64::from(a))));
                state.db.set_title_rating(t.id, cert.as_deref(), age, &region, now).await?;
            }
            // Tried again at the next round (TMDB down, or rate-limited).
            Err(e) => {
                tracing::debug!(tmdb_id = t.tmdb_id, error = %e, "age rating lookup failed");
                anyhow::bail!("TMDB didn't answer");
            }
        }
    }
    Ok(n)
}
