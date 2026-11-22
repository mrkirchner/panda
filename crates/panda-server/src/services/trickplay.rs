//! Scrub previews, made on demand one frame at a time (see `panda_media::trickplay`) and
//! cached on disk per item and 10-second step, so scrubbing back over a stretch is instant.

use std::path::{Path, PathBuf};

use panda_db::Item;
use panda_media::probe::MediaInfo;
use panda_media::trickplay;
use tokio::sync::Semaphore;

use crate::state::AppState;

/// A few at once: scrubbing fires requests in quick succession, but each one is an ffmpeg.
const CONCURRENT: usize = 3;
static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// One frame normally takes about a second, even from a network share.
const FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug)]
pub(crate) struct Trickplay {
    jobs: Semaphore,
}

impl Default for Trickplay {
    fn default() -> Self {
        Self { jobs: Semaphore::new(CONCURRENT) }
    }
}

/// Where an item's previews are cached. The file size is in the name, so a replaced file
/// (a Radarr upgrade) gets fresh previews.
pub(crate) fn dir(cache_dir: &Path, item: &Item) -> PathBuf {
    cache_dir.join("previews").join(format!("{}-{}", item.id, item.size_bytes))
}

impl Trickplay {
    /// The JPEG for the step containing `secs`, from the cache or made now.
    pub(crate) async fn frame(
        &self,
        state: &AppState,
        item: &Item,
        media: &MediaInfo,
        secs: u32,
    ) -> panda_media::Result<Vec<u8>> {
        let step = trickplay::step_for(f64::from(secs));
        let path = dir(&state.config.cache_dir(), item).join(format!("{step}.jpg"));
        if let Ok(bytes) = tokio::fs::read(&path).await {
            return Ok(bytes);
        }
        let _permit = self.jobs.acquire().await.map_err(|e| std::io::Error::other(e.to_string()))?;
        // Another request may have made it while this one waited.
        if let Ok(bytes) = tokio::fs::read(&path).await {
            return Ok(bytes);
        }
        // One keyframe; a share that stops answering mustn't hold a permit forever.
        let bytes = tokio::time::timeout(
            FRAME_TIMEOUT,
            trickplay::frame(
                &state.ffmpeg,
                Path::new(&item.path),
                step,
                media,
                state.caps.software_tonemap(),
            ),
        )
        .await
        .map_err(|_| std::io::Error::other("scrub preview timed out"))??;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Write then rename, so a reader never sees half a file.
        // Unique per write: two requests for the same frame never share a temp file.
        let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(bytes)
    }
}
