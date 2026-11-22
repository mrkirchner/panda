//! Keeps the cache under `[server] cache_max_gb`. Only what's made on demand is trimmed, oldest
//! first: scrub previews, preview clips and subtitles (all remade the next time they're needed). Artwork stays:
//! library pages point at it, and it only grows with the library.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::state::AppState;

/// How often the cache is measured.
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Trimming goes this far below the ceiling, so it isn't hit again at once.
const TARGET: f64 = 0.9;
/// Entries written this recently are left alone (an extraction may still be filling them).
const IN_USE: Duration = Duration::from_secs(10 * 60);
/// Folders of the old full-file previews (no longer used): removed whole.
const RETIRED: [&str; 1] = ["trickplay"];

/// The setting that overrides `[server] cache_max_gb` (set in the admin UI).
pub(crate) const CACHE_MAX_GB: &str = "cache_max_gb";

/// The ceiling in GB: the admin UI's setting, else panda.toml's (default 20); 0 = none.
pub(crate) async fn limit_gb(state: &AppState) -> Option<f64> {
    match state.db.setting(CACHE_MAX_GB).await {
        Ok(Some(s)) if !s.encrypted => s.value.parse().ok(),
        _ => state.config.server.cache_max_gb,
    }
}

/// Bytes used by what the ceiling covers (previews, subtitles) and by artwork.
pub(crate) async fn usage(state: &AppState) -> (u64, u64) {
    let cache = state.config.cache_dir();
    tokio::task::spawn_blocking(move || {
        let size = |p: PathBuf| measure(&p).0;
        (
            size(cache.join("previews")) + size(cache.join("subtitles")) + size(cache.join("clips")),
            size(cache.join("images")),
        )
    })
    .await
    .unwrap_or((0, 0))
}

pub(crate) fn spawn_trim(state: AppState) {
    tokio::spawn(async move {
        let cache = state.config.cache_dir();
        for old in RETIRED {
            let _ = tokio::fs::remove_dir_all(cache.join(old)).await;
        }
        loop {
            // Read each time: the limit can be changed in Settings.
            if let Some(gb) = limit_gb(&state).await.filter(|g| *g > 0.0) {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let max = (gb * 1_000_000_000.0) as u64;
                let dirs = [cache.join("previews"), cache.join("subtitles"), cache.join("clips")];
                let freed = tokio::task::spawn_blocking(move || trim(&dirs, max)).await.unwrap_or(0);
                if freed > 0 {
                    tracing::info!(freed_mb = freed / 1_000_000, "trimmed the cache");
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Remove the oldest entries (a title's previews, a subtitle track) until under `max * TARGET`.
/// Returns the bytes freed.
fn trim(dirs: &[PathBuf], max: u64) -> u64 {
    let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for dir in dirs {
        let Ok(list) = std::fs::read_dir(dir) else { continue };
        for e in list.flatten() {
            let path = e.path();
            let (size, newest) = measure(&path);
            entries.push((newest, size, path));
        }
    }
    let mut total: u64 = entries.iter().map(|e| e.1).sum();
    if total <= max {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
    let target = (max as f64 * TARGET) as u64;
    entries.sort_by_key(|e| e.0);
    let now = SystemTime::now();
    let mut freed = 0;
    for (when, size, path) in entries {
        if total <= target {
            break;
        }
        if now.duration_since(when).unwrap_or_default() < IN_USE {
            continue;
        }
        let removed =
            if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if removed.is_ok() {
            total -= size;
            freed += size;
        }
    }
    freed
}

/// Size of a file or folder, and when anything in it was last written.
fn measure(path: &Path) -> (u64, SystemTime) {
    let Ok(meta) = std::fs::metadata(path) else { return (0, SystemTime::UNIX_EPOCH) };
    let mut newest = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if !meta.is_dir() {
        return (meta.len(), newest);
    }
    let mut size = 0;
    for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let (s, t) = measure(&e.path());
        size += s;
        newest = newest.max(t);
    }
    (size, newest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_oldest_first_down_to_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let previews = dir.path().join("previews");
        std::fs::create_dir_all(&previews).unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        for (name, age) in [("a", 3), ("b", 2), ("c", 1)] {
            let d = previews.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let f = d.join("10.jpg");
            std::fs::write(&f, vec![0u8; 1000]).unwrap();
            let t = old - Duration::from_secs(age * 60);
            std::fs::File::options().write(true).open(&f).unwrap().set_modified(t).unwrap();
            std::fs::File::open(&d).unwrap().set_modified(t).unwrap();
        }
        // 3000 bytes against a 2500 ceiling: down to 2250, so the oldest ("a") goes.
        assert_eq!(trim(std::slice::from_ref(&previews), 2500), 1000);
        assert!(!previews.join("a").exists() && previews.join("b").exists() && previews.join("c").exists());
        // Recent entries are never removed, even over the ceiling.
        std::fs::write(previews.join("new.vtt"), vec![0u8; 5000]).unwrap();
        trim(std::slice::from_ref(&previews), 100);
        assert!(previews.join("new.vtt").exists());
    }
}
