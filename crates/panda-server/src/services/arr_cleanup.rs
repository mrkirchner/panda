//! Weekly tidy-up of Radarr/Sonarr: titles Panda requested that are done (in the library a week,
//! quality met, and for shows: ended, every wanted episode downloaded) come off their lists.
//! Files are never deleted; titles added to Radarr/Sonarr by hand are never touched.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use panda_arr::radarr::Movie;
use panda_arr::sonarr::{EpisodeFile, Series};
use panda_db::RequestKind;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

/// The setting (plain JSON): which kinds are cleaned up. Off unless turned on.
pub(crate) const CLEANUP: &str = "arr_cleanup";
/// When the last sweep ran (Unix seconds), so restarts don't reset the week.
const LAST_RUN: &str = "arr_cleanup.last_run";
const EVERY: Duration = Duration::from_secs(7 * 86_400);
/// Downloaded at least this long ago (time to notice a bad file or swap it).
const MIN_AGE: chrono::Duration = chrono::Duration::days(7);
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CleanupSettings {
    #[serde(default)]
    pub movies: bool,
    #[serde(default)]
    pub shows: bool,
}

pub(crate) async fn read(state: &AppState) -> CleanupSettings {
    crate::services::settings::read_json(state, CLEANUP).await
}

pub(crate) async fn write(state: &AppState, c: CleanupSettings) -> crate::error::ApiResult<()> {
    crate::services::settings::write_json(state, CLEANUP, &c).await
}

/// A movie that's finished: its file is there, a week old, and Radarr isn't after a better one.
pub(crate) fn movie_done(m: &Movie, now: DateTime<Utc>) -> bool {
    m.has_file
        && m.movie_file
            .as_ref()
            .is_some_and(|f| !f.quality_cutoff_not_met && f.date_added.is_some_and(|d| now - d >= MIN_AGE))
}

/// A show that's finished: no more episodes coming, every monitored episode downloaded (the
/// seasons asked for), none waiting for a better release, the newest a week old.
pub(crate) fn show_done(s: &Series, files: &[EpisodeFile], now: DateTime<Utc>) -> bool {
    let Some(stats) = &s.statistics else { return false };
    let complete = stats.episode_count > 0 && stats.episode_file_count >= stats.episode_count;
    let newest = files.iter().filter_map(|f| f.date_added).max();
    s.has_ended()
        && complete
        && !files.is_empty()
        && files.iter().all(|f| !f.quality_cutoff_not_met)
        && newest.is_some_and(|d| now - d >= MIN_AGE)
}

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        // Let startup (scans, imports) settle first.
        tokio::time::sleep(Duration::from_secs(10 * 60)).await;
        loop {
            let settings = read(&state).await;
            let last =
                state.db.setting(LAST_RUN).await.ok().flatten().and_then(|s| s.value.parse::<i64>().ok());
            let now = crate::services::settings::now();
            #[allow(clippy::cast_possible_wrap)]
            let due = last.is_none_or(|l| now - l >= EVERY.as_secs() as i64);
            if (settings.movies || settings.shows) && due {
                // Only a run that worked counts: a failed one (Radarr down) is retried at the next
                // check instead of waiting a week.
                match sweep(&state, settings).await {
                    Ok(n) => {
                        tracing::info!(removed = n, "cleaned up finished titles from Radarr/Sonarr");
                        let _ = state.db.set_setting(LAST_RUN, &now.to_string(), false, now).await;
                    }
                    Err(e) => tracing::warn!(error = %e, "Radarr/Sonarr cleanup failed; retrying later"),
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// One pass over every Radarr/Sonarr (HD and 4K). Returns how many entries were removed.
pub(crate) async fn sweep(state: &AppState, settings: CleanupSettings) -> anyhow::Result<usize> {
    let requests = state.db.requests().await?;
    let requested = |kind: RequestKind| -> HashSet<i64> {
        requests.iter().filter(|r| r.kind == kind).filter_map(|r| r.tmdb_id).collect()
    };
    let requested_tvdb: HashSet<i64> =
        requests.iter().filter(|r| r.kind == RequestKind::Series).filter_map(|r| r.tvdb_id).collect();
    let (lib_movies, lib_shows) = state.db.library_tmdb_ids().await?;
    let (lib_movies, lib_shows): (HashSet<i64>, HashSet<i64>) =
        (lib_movies.into_iter().collect(), lib_shows.into_iter().collect());
    let now = Utc::now();
    let integrations = state.integrations();
    let mut removed = 0;

    if settings.movies {
        let wanted = requested(RequestKind::Movie);
        for (tier, radarr) in integrations.radarrs() {
            for m in radarr.client.movies().await? {
                let Some(id) = m.id else { continue };
                if wanted.contains(&m.tmdb_id) && lib_movies.contains(&m.tmdb_id) && movie_done(&m, now) {
                    radarr.client.remove_movie(id).await?;
                    tracing::info!(title = %m.title, server = tier.label(), "removed finished movie from Radarr");
                    removed += 1;
                }
            }
        }
    }
    if settings.shows {
        let wanted = requested(RequestKind::Series);
        for (tier, sonarr) in integrations.sonarrs() {
            for s in sonarr.client.all_series().await? {
                let Some(id) = s.id else { continue };
                let ours =
                    s.tmdb_id.is_some_and(|t| wanted.contains(&t)) || requested_tvdb.contains(&s.tvdb_id);
                let in_library = s.tmdb_id.is_some_and(|t| lib_shows.contains(&t));
                if !(ours && in_library && s.has_ended()) {
                    continue;
                }
                let files = sonarr.client.episode_files(id).await?;
                if show_done(&s, &files, now) {
                    sonarr.client.remove_series(id).await?;
                    tracing::info!(title = %s.title, server = tier.label(), "removed finished show from Sonarr");
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use panda_arr::radarr::MovieFile;
    use panda_arr::sonarr::SeriesStatistics;

    fn movie(cutoff_not_met: bool, days: i64) -> Movie {
        serde_json::from_value(serde_json::json!({
            "id": 1, "title": "M", "tmdbId": 1, "hasFile": true,
        }))
        .map(|mut m: Movie| {
            m.movie_file = Some(MovieFile {
                date_added: Some(Utc::now() - chrono::Duration::days(days)),
                quality_cutoff_not_met: cutoff_not_met,
            });
            m
        })
        .unwrap()
    }

    fn show(ended: bool, have: i64, want: i64) -> Series {
        let mut s: Series = serde_json::from_value(serde_json::json!({ "title": "S", "tvdbId": 1 })).unwrap();
        s.ended = ended;
        s.statistics = Some(SeriesStatistics { episode_file_count: have, episode_count: want });
        s
    }

    fn files(days: i64, cutoff_not_met: bool) -> Vec<EpisodeFile> {
        vec![EpisodeFile {
            date_added: Some(Utc::now() - chrono::Duration::days(days)),
            quality_cutoff_not_met: cutoff_not_met,
        }]
    }

    #[test]
    fn movies_go_once_a_week_old_with_quality_met() {
        let now = Utc::now();
        assert!(movie_done(&movie(false, 8), now));
        assert!(!movie_done(&movie(false, 2), now), "too recent");
        assert!(!movie_done(&movie(true, 30), now), "waiting for an upgrade");
    }

    #[test]
    fn shows_go_only_when_ended_and_complete() {
        let now = Utc::now();
        assert!(show_done(&show(true, 10, 10), &files(8, false), now));
        assert!(!show_done(&show(false, 10, 10), &files(8, false), now), "still airing");
        assert!(!show_done(&show(true, 9, 10), &files(8, false), now), "an episode missing");
        assert!(!show_done(&show(true, 10, 10), &files(3, false), now), "too recent");
        assert!(!show_done(&show(true, 10, 10), &files(8, true), now), "waiting for an upgrade");
    }
}
