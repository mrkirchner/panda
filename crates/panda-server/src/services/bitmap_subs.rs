//! Image subtitles (PGS) for client overlay rendering. Never burned into video.
//!
//! The first request for a track starts ffmpeg copying it out of the file into a `.sup` (one
//! background job per track). That read goes through the file from the start much faster than
//! playback, so the manifest can be served while it's still running: it lists every complete
//! cue so far and says whether extraction is finished; players ask again until it is. Each
//! cue image is written once as a PNG and served from disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use panda_db::Item;
use panda_media::pgs::{self, Cue};
use serde::Serialize;
use tokio::process::Command;

use crate::state::AppState;

/// Codecs this handles (Blu-ray PGS). DVD `VobSub` needs a different extractor.
pub(crate) fn supported(codec: &str) -> bool {
    codec == "hdmv_pgs_subtitle"
}

const SUP: &str = "track.sup";
const DONE: &str = "done";
/// A full read of the file (a remux on a network share can be large and slow).
const EXTRACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// Decoded tracks kept in memory (each can be a few hundred MB of RGBA).
const PARSED_KEPT: usize = 4;

/// A track's cues and the `.sup` size they were parsed from.
type Parsed = (u64, Arc<Vec<Cue>>);

#[derive(Debug, Default)]
pub(crate) struct BitmapSubs {
    running: Mutex<HashSet<(i64, u32)>>,
    /// Parsed cues per track, with the `.sup` size they came from (re-parsed when it grows).
    parsed: Mutex<HashMap<(i64, u32), Parsed>>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImageRef {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// File name under the track's image route (`<cue>_<image>.png`).
    pub file: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CueRef {
    pub start: f64,
    pub end: f64,
    pub images: Vec<ImageRef>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Manifest {
    /// Extraction finished: no more cues will appear.
    pub complete: bool,
    /// The frame the image positions refer to.
    pub video_width: u32,
    pub video_height: u32,
    pub cues: Vec<CueRef>,
}

/// Where a track's files live. The file size is in the name, so a replaced file starts over.
pub(crate) fn dir(cache_dir: &Path, item: &Item, index: u32) -> PathBuf {
    cache_dir.join("subtitles").join(format!("{}-{}-{index}-pgs", item.id, item.size_bytes))
}

/// `12_0.png`: the only names served from a track directory.
pub(crate) fn is_image_name(name: &str) -> bool {
    name.strip_suffix(".png").and_then(|n| n.split_once('_')).is_some_and(|(a, b)| {
        !a.is_empty()
            && !b.is_empty()
            && a.bytes().all(|c| c.is_ascii_digit())
            && b.bytes().all(|c| c.is_ascii_digit())
    })
}

impl BitmapSubs {
    /// The cues so far (starting extraction if needed), with their images written to disk.
    pub(crate) async fn manifest(
        &self,
        state: &AppState,
        item: &Item,
        index: u32,
    ) -> std::io::Result<Manifest> {
        let dir = dir(&state.config.cache_dir(), item, index);
        let complete = tokio::fs::try_exists(dir.join(DONE)).await.unwrap_or(false);
        if !complete {
            self.start(state, item, index, &dir).await?;
        }
        let mut cues = self.cues(item.id, index, &dir).await?;
        // The cache keeps cues without pixels once their PNGs are on disk: if one has gone since
        // (cache trim), parse the track again to have the pixels.
        if missing_pixels(&cues, &dir).await {
            lock(&self.parsed).remove(&(item.id, index));
            cues = self.cues(item.id, index, &dir).await?;
        }
        let mut out = Vec::with_capacity(cues.len());
        for (n, cue) in cues.iter().enumerate() {
            let mut images = Vec::with_capacity(cue.images.len());
            for (k, img) in cue.images.iter().enumerate() {
                let file = format!("{n}_{k}.png");
                let path = dir.join(&file);
                if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
                    // Deflate is CPU work: off the async threads.
                    let (w, h, rgba) = (img.width, img.height, img.rgba.clone());
                    let png = tokio::task::spawn_blocking(move || pgs::encode_png(w, h, &rgba))
                        .await
                        .map_err(std::io::Error::other)?;
                    let tmp = path.with_extension("tmp");
                    tokio::fs::write(&tmp, png).await?;
                    tokio::fs::rename(&tmp, &path).await?;
                }
                images.push(ImageRef { x: img.x, y: img.y, width: img.width, height: img.height, file });
            }
            out.push(CueRef { start: cue.start, end: cue.end, images });
        }
        // Every PNG is on disk now: keep only timings and positions in memory (a decoded track's
        // pixels can run to hundreds of MB).
        if let Some(entry) = lock(&self.parsed).get_mut(&(item.id, index)) {
            entry.1 = Arc::new(without_pixels(&cues));
        }
        let (w, h) = cues.first().map_or((1920, 1080), |c| (c.video_width, c.video_height));
        Ok(Manifest { complete, video_width: w, video_height: h, cues: out })
    }

    /// Parse the `.sup` (cached while its size is unchanged).
    async fn cues(&self, id: i64, index: u32, dir: &Path) -> std::io::Result<Arc<Vec<Cue>>> {
        let path = dir.join(SUP);
        let len = tokio::fs::metadata(&path).await.map_or(0, |m| m.len());
        if let Some((l, c)) = lock(&self.parsed).get(&(id, index))
            && *l == len
        {
            return Ok(c.clone());
        }
        let data = if len > 0 { tokio::fs::read(&path).await? } else { Vec::new() };
        let cues = Arc::new(tokio::task::spawn_blocking(move || pgs::parse(&data)).await.unwrap_or_default());
        let mut parsed = lock(&self.parsed);
        if parsed.len() >= PARSED_KEPT && !parsed.contains_key(&(id, index)) {
            parsed.clear();
        }
        parsed.insert((id, index), (len, cues.clone()));
        Ok(cues)
    }

    /// Start copying the track out, unless that's already running.
    async fn start(&self, state: &AppState, item: &Item, index: u32, dir: &Path) -> std::io::Result<()> {
        if !lock(&self.running).insert((item.id, index)) {
            return Ok(());
        }
        tokio::fs::create_dir_all(dir).await?;
        let args: Vec<String> = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            &item.path,
            "-map",
            &format!("0:{index}"),
            "-c:s",
            "copy",
            "-f",
            "sup",
            &dir.join(SUP).to_string_lossy(),
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        let (state, dir, id) = (state.clone(), dir.to_path_buf(), item.id);
        tokio::spawn(async move {
            let run = Command::new(&state.ffmpeg.ffmpeg).args(&args).kill_on_drop(true).output();
            match tokio::time::timeout(EXTRACT_TIMEOUT, run).await {
                Ok(Ok(out)) if out.status.success() => {
                    tracing::info!(item = id, index, "extracted image subtitles");
                }
                Ok(Ok(out)) => tracing::warn!(
                    item = id, index, stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                    "image subtitle extraction failed"
                ),
                Ok(Err(e)) => tracing::warn!(item = id, index, error = %e, "could not run ffmpeg"),
                Err(_) => tracing::warn!(item = id, index, "image subtitle extraction timed out"),
            }
            // Finished either way: what was extracted is what there is. Without this a failure
            // would restart the whole pass on every poll.
            let _ = tokio::fs::write(dir.join(DONE), b"").await;
            lock(&state.bitmap_subs.running).remove(&(id, index));
        });
        Ok(())
    }
}

/// Cues with their positions and timings but not their pixels.
fn without_pixels(cues: &[Cue]) -> Vec<Cue> {
    cues.iter()
        .map(|c| Cue {
            start: c.start,
            end: c.end,
            video_width: c.video_width,
            video_height: c.video_height,
            images: c
                .images
                .iter()
                .map(|i| pgs::CueImage { x: i.x, y: i.y, width: i.width, height: i.height, rgba: Vec::new() })
                .collect(),
        })
        .collect()
}

/// Some image has neither its PNG on disk nor its pixels in memory.
async fn missing_pixels(cues: &[Cue], dir: &Path) -> bool {
    for (n, cue) in cues.iter().enumerate() {
        for (k, img) in cue.images.iter().enumerate() {
            if img.rgba.is_empty()
                && !tokio::fs::try_exists(dir.join(format!("{n}_{k}.png"))).await.unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

/// A poisoned map only means a job panicked mid-update; the data is still usable.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cue_images_are_served() {
        assert!(is_image_name("12_0.png"));
        assert!(!is_image_name("track.sup"));
        assert!(!is_image_name("done"));
        assert!(!is_image_name("_0.png"));
        assert!(!is_image_name("1_.png"));
        assert!(!is_image_name("../1_0.png"));
        assert!(!is_image_name("1_0.png.tmp"));
    }
}
