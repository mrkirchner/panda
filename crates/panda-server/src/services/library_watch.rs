//! Watch library folders so files copied in by hand show up within seconds. Events are
//! debounced per folder (a copy fires many) and the folder's library is rescanned once things
//! go quiet. Setting a watch up can hang on a stalled network mount, so it's time-limited, and
//! the interval scan stays as the backstop (network shares don't always report changes).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::state::AppState;

/// Rescan once a folder has had no changes for this long (a big copy is still writing).
const QUIET: Duration = Duration::from_secs(15);
const TICK: Duration = Duration::from_secs(5);
/// Libraries added or changed later get watched within this long.
const RESYNC: Duration = Duration::from_secs(5 * 60);
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Adds, removes and renames matter; reads and attribute changes don't.
fn relevant(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
    )
}

pub(crate) fn spawn(state: AppState) {
    if !state.config.scanning.watch.unwrap_or(true) {
        return;
    }
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let mut watchers: HashMap<String, RecommendedWatcher> = HashMap::new();
        let mut pending: HashMap<String, Instant> = HashMap::new();
        let mut last_sync: Option<Instant> = None;
        let mut tick = tokio::time::interval(TICK);
        loop {
            tokio::select! {
                Some(folder) = rx.recv() => { pending.insert(folder, Instant::now()); }
                _ = tick.tick() => {
                    if last_sync.is_none_or(|t| t.elapsed() >= RESYNC) {
                        sync(&state, &mut watchers, &tx).await;
                        last_sync = Some(Instant::now());
                    }
                    let ready: Vec<String> =
                        pending.iter().filter(|(_, at)| at.elapsed() >= QUIET).map(|(f, _)| f.clone()).collect();
                    for folder in ready {
                        // A scan is running: try again shortly (it may have missed this change).
                        if state.scan_lock.try_lock().is_err() {
                            pending.insert(folder, Instant::now());
                            continue;
                        }
                        pending.remove(&folder);
                        tracing::info!(folder, "library folder changed; rescanning");
                        crate::services::scanner::spawn_scan_for_path(state.clone(), folder);
                    }
                }
            }
        }
    });
}

/// Watch every library folder not watched yet; stop watching removed ones.
async fn sync(
    state: &AppState,
    watchers: &mut HashMap<String, RecommendedWatcher>,
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
) {
    let Ok(libraries) = state.db.libraries().await else { return };
    let folders: HashSet<String> = libraries.into_iter().flat_map(|l| l.folders).collect();
    watchers.retain(|f, _| folders.contains(f));
    for folder in folders {
        if watchers.contains_key(&folder) {
            continue;
        }
        let (tx, f) = (tx.clone(), folder.clone());
        let setup = tokio::task::spawn_blocking(move || {
            let notify_folder = f.clone();
            let mut w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
                if let Ok(e) = ev
                    && relevant(e.kind)
                {
                    let _ = tx.send(notify_folder.clone());
                }
            })?;
            w.watch(Path::new(&f), RecursiveMode::Recursive)?;
            Ok::<_, notify::Error>(w)
        });
        match tokio::time::timeout(SETUP_TIMEOUT, setup).await {
            Ok(Ok(Ok(w))) => {
                tracing::info!(folder, "watching library folder for changes");
                watchers.insert(folder, w);
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!(folder, error = %e, "can\'t watch library folder; interval scans only");
            }
            _ => tracing::warn!(folder, "library folder didn't answer; will try watching it again later"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_adds_removes_and_renames_trigger_a_scan() {
        use notify::event::{AccessKind, CreateKind, MetadataKind, ModifyKind, RenameMode};
        assert!(relevant(EventKind::Create(CreateKind::File)));
        assert!(relevant(EventKind::Modify(ModifyKind::Name(RenameMode::Any))));
        assert!(!relevant(EventKind::Access(AccessKind::Any)));
        assert!(!relevant(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))));
    }
}
