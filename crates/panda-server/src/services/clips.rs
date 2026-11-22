//! Preview clips for the TV's home hero and expanded cards (see `panda_media::clip`): made on
//! first request from the title's smallest version, then cached per item. Two at most at a time:
//! each is a short software encode, and browsing fires requests as focus moves.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use panda_db::Item;
use panda_media::clip;
use panda_media::probe::MediaInfo;
use tokio::sync::Semaphore;

use crate::state::AppState;

const CONCURRENT: usize = 2;
static JOB: AtomicU64 = AtomicU64::new(0);
/// A clip that takes longer than this is abandoned (a stalled share, a pathological file).
const MAKE_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the file may take to answer before its storage is treated as offline.
const FILE_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub(crate) struct Clips {
    jobs: Semaphore,
}

impl Default for Clips {
    fn default() -> Self {
        Self { jobs: Semaphore::new(CONCURRENT) }
    }
}

/// Where an item's clip is cached. The file size is in the name, so a replaced file (a Radarr
/// upgrade) gets a fresh clip.
pub(crate) fn path(cache_dir: &Path, item: &Item) -> PathBuf {
    cache_dir.join("clips").join(format!("{}-{}.mp4", item.id, item.size_bytes))
}

impl Clips {
    /// The item's clip, from the cache or made now.
    pub(crate) async fn ensure(
        &self,
        state: &AppState,
        item: &Item,
        media: &MediaInfo,
    ) -> std::io::Result<PathBuf> {
        let out = path(&state.config.cache_dir(), item);
        if tokio::fs::try_exists(&out).await.unwrap_or(false) {
            return Ok(out);
        }
        let _permit = self.jobs.acquire().await.map_err(|e| std::io::Error::other(e.to_string()))?;
        // Another request may have made it while this one waited.
        if tokio::fs::try_exists(&out).await.unwrap_or(false) {
            return Ok(out);
        }
        // Libraries live on shares that can drop: never let ffmpeg hang on one.
        let source = PathBuf::from(&item.path);
        let check = source.clone();
        match tokio::time::timeout(FILE_CHECK_TIMEOUT, tokio::task::spawn_blocking(move || check.is_file()))
            .await
        {
            Ok(Ok(true)) => {}
            _ => return Err(std::io::Error::other("the title's storage isn't reachable")),
        }
        if let Some(parent) = out.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Written beside, then renamed: a reader never sees half a clip.
        // Unique per job: two requests making the same clip never write one file.
        let tmp = out.with_extension(format!(
            "{}.{}.part.mp4",
            std::process::id(),
            JOB.fetch_add(1, Ordering::Relaxed)
        ));
        let start = clip::start_for(media.duration_secs.or(item.duration_secs));
        let made = tokio::time::timeout(
            MAKE_TIMEOUT,
            clip::make(&state.ffmpeg, &source, &tmp, start, media, state.caps.software_tonemap()),
        )
        .await;
        match made {
            Ok(Ok(())) => {
                tokio::fs::rename(&tmp, &out).await?;
                Ok(out)
            }
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(std::io::Error::other(e.to_string()))
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(std::io::Error::other("preview clip timed out"))
            }
        }
    }
}
