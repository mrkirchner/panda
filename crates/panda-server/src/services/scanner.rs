//! Library scan: walk -> upsert -> ffprobe new/changed files -> prune deleted ones.

use std::sync::Arc;

use panda_db::{Library, ProbeSummary};
use panda_media::probe;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::services::metadata;
use crate::state::AppState;

/// Concurrent ffprobe processes. Probing is I/O bound but each process is heavy.
const PROBE_CONCURRENCY: usize = 4;

fn mark_scanned(state: &AppState) {
    state.last_scan_at.store(crate::services::settings::now(), std::sync::atomic::Ordering::Relaxed);
}

/// Rescan every library on an interval (`[scanning] interval_minutes`), so files added to a
/// library's folders show up on their own.
pub(crate) fn spawn_periodic_scans(state: AppState) {
    let Some(every) = state.config.scanning.interval() else {
        tracing::info!("periodic library scans are off");
        return;
    };
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.tick().await; // The startup scan already covers "now".
        loop {
            tick.tick().await;
            if let Err(e) = scan_all(&state).await {
                tracing::error!(error = %e, "periodic library scan failed");
            }
        }
    });
}

/// Start a full scan in the background (queued if one is already running).
pub(crate) fn spawn_scan(state: AppState) {
    tokio::spawn(async move {
        if let Err(e) = scan_all(&state).await {
            tracing::error!(error = %e, "library scan failed");
        }
    });
}

/// Rescan just the folder `path` is in (Sonarr/Radarr webhooks, the folder watcher): a new
/// episode doesn't re-read the whole share. Queued if a scan is already running.
pub(crate) fn spawn_scan_for_path(state: AppState, path: String) {
    tokio::spawn(async move {
        let Ok(_guard) = state.scan_lock.try_lock() else {
            tracing::info!(path, "scan running; this folder is queued after it");
            queue(&state, Some(path));
            return;
        };
        scan_folders(&state, &[path]).await;
        metadata::enrich(&state).await;
        mark_scanned(&state);
        crate::services::request_ready::after_scan(&state).await;
        run_queued(&state).await;
    });
}

fn queue(state: &AppState, scan: Option<String>) {
    let mut q = state.pending_scans.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !q.contains(&scan) {
        q.push(scan);
    }
}

/// Scans asked for while the lock was held (call with it held): a full scan if any asked for
/// everything, else each folder; repeated until nothing more arrives.
async fn run_queued(state: &AppState) {
    loop {
        let queued: Vec<Option<String>> = std::mem::take(
            &mut *state.pending_scans.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        if queued.is_empty() {
            return;
        }
        if queued.contains(&None) {
            if let Err(e) = scan_libraries(state).await {
                tracing::error!(error = %e, "queued library scan failed");
            }
        } else {
            let paths: Vec<String> = queued.into_iter().flatten().collect();
            scan_folders(state, &paths).await;
        }
        metadata::enrich(state).await;
        mark_scanned(state);
    }
}

/// The folder a changed path's scan should walk: the path's own folder (a file's parent), or
/// the nearest existing one above it inside the library (a deleted folder's parent). Checked
/// off the runtime with a timeout (a share can hang); `None` if it doesn't answer.
async fn scan_root(lib: &Library, path: &str) -> Option<String> {
    let base = lib.folder_for(path)?.trim_end_matches('/').to_string();
    let mut p = std::path::PathBuf::from(path);
    let limit = base.len();
    let find = tokio::task::spawn_blocking(move || {
        if p.is_file() {
            p.pop();
        }
        while !p.is_dir() && p.as_os_str().len() > limit {
            p.pop();
        }
        p
    });
    let Ok(Ok(p)) = tokio::time::timeout(FOLDER_CHECK_TIMEOUT, find).await else {
        tracing::warn!(library = %lib.name, path, "folder not responding; not scanning it");
        return None;
    };
    let root = p.to_string_lossy().trim_end_matches('/').to_string();
    Some(if root.len() < base.len() { base } else { root })
}

/// Partial scans of the libraries containing `paths`.
async fn scan_folders(state: &AppState, paths: &[String]) {
    let Ok(libraries) = state.db.libraries().await else { return };
    for lib in &libraries {
        for path in paths {
            let Some(root) = scan_root(lib, path).await else { continue };
            if let Err(e) = scan_library(state, lib, Some(&root)).await {
                tracing::error!(library = %lib.name, folder = %root, error = %e, "scan failed");
            }
        }
    }
}

/// Background scans queue a full scan if one is already running.
pub(crate) async fn scan_all(state: &AppState) -> anyhow::Result<()> {
    let Ok(_guard) = state.scan_lock.try_lock() else {
        tracing::info!("scan already running; another full scan is queued after it");
        queue(state, None);
        return Ok(());
    };
    scan_all_locked(state).await
}

/// Wait for any running scan, then scan everything (so files added meanwhile are included).
pub(crate) async fn scan_all_waiting(state: &AppState) -> anyhow::Result<()> {
    let _guard = state.scan_lock.lock().await;
    scan_all_locked(state).await
}

async fn scan_libraries(state: &AppState) -> anyhow::Result<()> {
    for lib in state.db.libraries().await? {
        // One unreachable library shouldn't stop the others from picking up new files.
        if let Err(e) = scan_library(state, &lib, None).await {
            tracing::error!(library = %lib.name, error = %e, "scan failed");
        }
    }
    Ok(())
}

async fn scan_all_locked(state: &AppState) -> anyhow::Result<()> {
    scan_libraries(state).await?;
    metadata::enrich(state).await;
    mark_scanned(state);
    crate::services::request_ready::after_scan(state).await;
    run_queued(state).await;
    Ok(())
}

/// How long a folder may take to answer "do you exist?" before it's treated as offline.
/// A stalled network mount blocks filesystem calls indefinitely; this keeps scans moving.
const FOLDER_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether a library folder is reachable, without letting a hung mount block the runtime.
pub(crate) async fn folder_online(path: &str) -> bool {
    let p = std::path::PathBuf::from(path);
    matches!(
        tokio::time::timeout(FOLDER_CHECK_TIMEOUT, tokio::task::spawn_blocking(move || p.is_dir())).await,
        Ok(Ok(true))
    )
}

/// The longest a folder's walk may take (a hung mount); the scan then skips it, no pruning.
const WALK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// The longest one ffprobe may take (it's killed on drop).
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Scan a library, or only its folder `only` (a partial scan prunes only under it).
async fn scan_library(state: &AppState, lib: &Library, only: Option<&str>) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let kind = lib.kind();
    let mut files = Vec::new();
    // Pruning deletes items not seen in this scan, so it's only safe if every folder answered.
    let mut complete = true;
    let roots: Vec<String> = only.map_or_else(|| lib.folders.clone(), |f| vec![f.to_string()]);
    for folder in &roots {
        // A partial scan still needs the library's own folder to answer (an unmounted share).
        let base = lib.folder_for(folder).unwrap_or(folder);
        if !folder_online(base).await {
            tracing::warn!(library = %lib.name, folder, "folder missing or not responding; skipping (no pruning)");
            complete = false;
            continue;
        }
        let root = std::path::PathBuf::from(folder);
        // A share that hangs mid-walk must not hold the scan (and every later one) forever.
        let walk = tokio::task::spawn_blocking(move || panda_library::scan_checked(&root, kind));
        let Ok(walked) = tokio::time::timeout(WALK_TIMEOUT, walk).await else {
            tracing::warn!(library = %lib.name, folder, "folder walk timed out; skipping (no pruning)");
            complete = false;
            continue;
        };
        let walked = walked?;
        // Anything unreadable (a share dropping mid-walk) makes this walk partial: pruning on
        // it would delete everything it didn't reach.
        if walked.errors > 0 {
            tracing::warn!(library = %lib.name, folder, errors = walked.errors, "some of the folder couldn't be read (no pruning)");
            complete = false;
        }
        // An unmounted share often leaves its empty mount folder behind: "no files at all" is
        // treated as offline rather than "everything was deleted".
        // (A folder inside a library that answers can really be empty: its files were deleted.
        // A library's own folder can't: that's the unmounted share again.)
        let inside = only.is_some_and(|o| o.trim_end_matches('/') != base.trim_end_matches('/'));
        if walked.files.is_empty() && !inside {
            tracing::warn!(library = %lib.name, folder, "folder is empty; treating it as offline (no pruning)");
            complete = false;
        }
        files.extend(walked.files);
    }
    let scan_gen = state.db.next_scan_gen().await?;

    // Most files haven't changed since the last scan: those are only marked seen, together, in
    // one transaction; new and changed ones are written (and probed).
    let stored = state.db.file_states(lib.id).await?;
    let mut seen = Vec::new();
    let permits = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
    let mut probes = JoinSet::new();
    for file in &files {
        if let Some(s) = stored.get(file.path.to_string_lossy().as_ref())
            && s.unchanged(file)
        {
            seen.push(s.id);
            continue;
        }
        let up = state.db.upsert_item(lib.id, scan_gen, file).await?;
        if !up.needs_probe {
            continue;
        }
        let (state, permits, path) = (state.clone(), permits.clone(), file.path.clone());
        probes.spawn(async move {
            let _permit = permits.acquire_owned().await;
            let Ok(result) = tokio::time::timeout(PROBE_TIMEOUT, probe::probe(&state.ffmpeg, &path)).await
            else {
                tracing::warn!(path = %path.display(), "ffprobe timed out");
                return;
            };
            match result {
                Ok(info) => {
                    let summary = ProbeSummary {
                        duration_secs: info.duration_secs,
                        video_codec: info.video.as_ref().map(|v| v.codec.clone()),
                        width: info.video.as_ref().map(|v| i64::from(v.width)),
                        height: info.video.as_ref().map(|v| i64::from(v.height)),
                        dynamic_range: info.video.as_ref().map(|v| format!("{:?}", v.range).to_lowercase()),
                    };
                    let json = serde_json::to_string(&info).unwrap_or_default();
                    if let Err(e) = state.db.set_probe(up.id, &summary, &json).await {
                        tracing::warn!(error = %e, "saving probe failed");
                    }
                }
                Err(e) => tracing::warn!(path = %path.display(), error = %e, "ffprobe failed"),
            }
        });
    }
    state.db.mark_seen(&seen, scan_gen).await?;
    let probe_count = probes.len();
    while probes.join_next().await.is_some() {}

    let pruned = match (complete, only) {
        (false, _) => 0,
        (true, None) => state.db.prune_items(lib.id, scan_gen).await?,
        (true, Some(folder)) => state.db.prune_items_under(lib.id, folder, scan_gen).await?,
    };
    tracing::info!(
        library = %lib.name, folder = only.unwrap_or("(all)"), files = files.len(), unchanged = seen.len(),
        probed = probe_count, pruned,
        elapsed_ms = started.elapsed().as_millis() as u64, "scan complete"
    );
    Ok(())
}
