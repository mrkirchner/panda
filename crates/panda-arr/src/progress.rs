//! Where a requested title is in Radarr/Sonarr: searching, downloading (how far), importing,
//! or on disk. Built from the title's file state plus its entries in the download queue.

use serde::{Deserialize, Serialize};

/// One download in Radarr/Sonarr's queue (`/api/v3/queue/details`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub sizeleft: f64,
    /// `importPending`, `importing`, `imported`, `downloading`, ...
    pub tracked_download_state: Option<String>,
    /// RFC 3339.
    pub estimated_completion_time: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Monitored, nothing found or grabbed yet.
    Searching,
    Downloading,
    /// Downloaded, being moved into the library.
    Importing,
    /// On disk (for shows: at least one episode).
    Available,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Progress {
    pub state: State,
    /// 0-1: download progress while downloading, share of episodes on disk for a show.
    pub fraction: f64,
    /// When the current download should finish (RFC 3339), if the client knows.
    pub eta: Option<String>,
}

/// Combine what's on disk with what's downloading. `on_disk` is 0-1 (a movie: 0 or 1; a show:
/// the share of its episodes). Anything still in the queue wins over "available", so a show
/// whose new episodes are downloading reads as downloading.
pub fn summarize(on_disk: f64, queue: &[QueueItem]) -> Progress {
    let importing = queue.iter().any(|q| {
        matches!(q.tracked_download_state.as_deref(), Some("importPending" | "importing" | "imported"))
    });
    let (size, left) = queue.iter().fold((0.0, 0.0), |(s, l), q| (s + q.size, l + q.sizeleft.min(q.size)));
    let eta = queue.iter().filter_map(|q| q.estimated_completion_time.clone()).max();
    if importing {
        return Progress { state: State::Importing, fraction: 1.0, eta: None };
    }
    if !queue.is_empty() {
        let fraction = if size > 0.0 { ((size - left) / size).clamp(0.0, 1.0) } else { 0.0 };
        return Progress { state: State::Downloading, fraction, eta };
    }
    if on_disk > 0.0 {
        return Progress { state: State::Available, fraction: on_disk.clamp(0.0, 1.0), eta: None };
    }
    Progress { state: State::Searching, fraction: 0.0, eta: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(size: f64, left: f64, state: &str) -> QueueItem {
        QueueItem {
            size,
            sizeleft: left,
            tracked_download_state: Some(state.into()),
            estimated_completion_time: Some("2026-11-20T06:00:00Z".into()),
        }
    }

    #[test]
    fn nothing_yet_is_searching() {
        assert_eq!(summarize(0.0, &[]).state, State::Searching);
    }

    #[test]
    fn download_progress_sums_the_queue() {
        let p = summarize(0.0, &[item(100.0, 75.0, "downloading"), item(100.0, 25.0, "downloading")]);
        assert_eq!(p.state, State::Downloading);
        assert!((p.fraction - 0.5).abs() < 1e-9);
        assert_eq!(p.eta.as_deref(), Some("2026-11-20T06:00:00Z"));
    }

    #[test]
    fn importing_and_available() {
        assert_eq!(summarize(0.0, &[item(10.0, 0.0, "importPending")]).state, State::Importing);
        let movie = summarize(1.0, &[]);
        assert_eq!((movie.state, movie.fraction), (State::Available, 1.0));
        // A show with 40% of its episodes on disk, nothing downloading.
        let show = summarize(0.4, &[]);
        assert_eq!((show.state, show.fraction), (State::Available, 0.4));
    }

    #[test]
    fn new_episodes_downloading_beat_available() {
        assert_eq!(summarize(0.4, &[item(10.0, 5.0, "downloading")]).state, State::Downloading);
    }

    #[test]
    fn odd_sizes_stay_in_range() {
        assert!(summarize(0.0, &[item(0.0, 0.0, "downloading")]).fraction.abs() < f64::EPSILON);
        assert!(summarize(0.0, &[item(10.0, 50.0, "downloading")]).fraction.abs() < f64::EPSILON);
    }
}
