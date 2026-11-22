//! The stream capacity test (`crate::bench`) run from the admin UI: one at a time, in the
//! background, never while anyone is streaming (it would spoil their playback and its own
//! numbers). Its last report is kept (a setting), and the hardware encode limit it suggests can
//! be applied (the `max_hardware_encodes` setting, over panda.toml's `[transcoding]
//! max_hardware`, applied at once and at every start).

use std::sync::{LazyLock, Mutex};

use serde::Serialize;

use crate::bench::{Options, Report};
use crate::error::{ApiError, ApiResult};
use crate::services::settings;
use crate::state::AppState;

/// The last finished report (JSON).
pub(crate) const REPORT: &str = "bench_report";
/// The admin's hardware encode limit, over panda.toml's.
pub(crate) const MAX_HARDWARE: &str = "max_hardware_encodes";

/// A test under way: its lines so far.
#[derive(Debug, Default, Clone, Serialize)]
pub(crate) struct Progress {
    pub running: bool,
    pub lines: Vec<String>,
    /// Why the last run stopped, when it failed.
    pub error: Option<String>,
}

static PROGRESS: LazyLock<Mutex<Progress>> = LazyLock::new(Mutex::default);

fn progress() -> std::sync::MutexGuard<'static, Progress> {
    PROGRESS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn current() -> Progress {
    progress().clone()
}

pub(crate) async fn last_report(state: &AppState) -> Option<Report> {
    settings::read_json::<Option<Report>>(state, REPORT).await
}

/// Start a test in the background. Refused while one runs or anyone streams.
pub(crate) fn start(state: &AppState, opts: Options) -> ApiResult<()> {
    let streams = state.sessions.counts();
    if streams.hardware + streams.software + streams.remux > 0 {
        return Err(ApiError::Conflict("Someone is watching: run the test when nothing is playing.".into()));
    }
    {
        let mut p = progress();
        if p.running {
            return Err(ApiError::Conflict("A test is already running.".into()));
        }
        *p = Progress { running: true, lines: Vec::new(), error: None };
    }
    let state = state.clone();
    tokio::spawn(async move {
        let work = state.config.cache_dir().join("bench");
        let result = crate::bench::measure(&state.ffmpeg, &state.caps, &state.db, &opts, &work, |line| {
            progress().lines.push(line);
        })
        .await;
        let error = match result {
            Ok(report) => {
                settings::write_json(&state, REPORT, &Some(report)).await.err().map(|e| e.to_string())
            }
            Err(e) => Some(e.to_string()),
        };
        if let Some(e) = &error {
            tracing::warn!(error = %e, "stream capacity test failed");
        }
        let mut p = progress();
        p.running = false;
        p.error = error;
    });
    Ok(())
}

/// Apply and keep an admin's hardware encode limit (1-64).
pub(crate) async fn set_hardware_limit(state: &AppState, n: usize) -> ApiResult<()> {
    if !(1..=64).contains(&n) {
        return Err(ApiError::Validation("the limit must be between 1 and 64".into()));
    }
    state.db.set_setting(MAX_HARDWARE, &n.to_string(), false, settings::now()).await?;
    state.sessions.set_hardware_limit(n);
    Ok(())
}

/// At start: the admin's limit, when one was set.
pub(crate) async fn apply_saved_limit(state: &AppState) {
    if let Ok(Some(s)) = state.db.setting(MAX_HARDWARE).await
        && !s.encrypted
        && let Ok(n) = s.value.parse::<usize>()
    {
        state.sessions.set_hardware_limit(n);
    }
}
