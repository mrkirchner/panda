//! Is each library's storage reachable? Checked every minute (with a time limit, so a hung
//! network mount can't stall anything). Apps show a notice while a library is offline, and when
//! it comes back it's rescanned so anything added meanwhile appears.

use std::collections::HashMap;
use std::time::Duration;

use crate::state::AppState;

const CHECK_EVERY: Duration = Duration::from_secs(60);
const FOLDER_TIMEOUT: Duration = Duration::from_secs(10);

/// A folder is up when it answers in time and isn't empty (an unmounted share often leaves an
/// empty mount folder behind).
async fn folder_up(path: &str) -> bool {
    let p = std::path::PathBuf::from(path);
    let check = tokio::task::spawn_blocking(move || {
        std::fs::read_dir(&p).is_ok_and(|mut entries| entries.next().is_some())
    });
    matches!(tokio::time::timeout(FOLDER_TIMEOUT, check).await, Ok(Ok(true)))
}

/// Check every library once; returns the ids that just came back online.
pub(crate) async fn check(state: &AppState) -> Vec<i64> {
    let Ok(libraries) = state.db.libraries().await else { return Vec::new() };
    let mut now = HashMap::new();
    for lib in &libraries {
        let mut up = !lib.folders.is_empty();
        for f in &lib.folders {
            if !folder_up(f).await {
                up = false;
                break;
            }
        }
        now.insert(lib.id, up);
    }
    let mut map = state.library_online.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let back: Vec<i64> =
        now.iter().filter(|(id, up)| **up && map.get(id) == Some(&false)).map(|(id, _)| *id).collect();
    for (id, up) in &now {
        if map.get(id) != Some(up) {
            let name = libraries.iter().find(|l| l.id == *id).map_or("?", |l| l.name.as_str());
            if *up {
                tracing::info!(library = name, "library storage is reachable again");
            } else {
                tracing::warn!(library = name, "library storage is offline");
            }
        }
    }
    *map = now;
    back
}

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            for id in check(&state).await {
                // Back online: pick up whatever arrived while it was away.
                if let Ok(libs) = state.db.libraries().await
                    && let Some(lib) = libs.into_iter().find(|l| l.id == id)
                {
                    for folder in lib.folders {
                        crate::services::scanner::spawn_scan_for_path(state.clone(), folder);
                    }
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Whether a library is known to be offline (unknown counts as online).
pub(crate) fn is_offline(state: &AppState, id: i64) -> bool {
    state.library_online.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&id) == Some(&false)
}
