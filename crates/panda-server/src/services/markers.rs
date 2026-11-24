//! Finding episodes' intros and credits in their sound (`panda_media::markers`), for "Skip
//! intro" and "Up next".
//!
//! A season at a time: each episode's start (its first quarter, at most 10 minutes) and end (its
//! last 5 minutes) are fingerprinted, and neighbouring episodes compared: what they share near the
//! start is the intro, near the end the credits. Only those parts of a file are read, one file at
//! a time; fingerprints are kept in the cache (`fingerprints/`), results in `audio_markers`.
//!
//! A season someone starts watching goes first (its later episodes are what they'll skip
//! through); the rest of the library is worked through while nobody streams. Nothing happens
//! without an ffmpeg that fingerprints (jellyfin-ffmpeg does): then only named chapters count.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use panda_db::{AudioMarkers, Item, SeasonKey};
use panda_media::markers::{self, Markers, Shared};
use panda_media::probe::MediaInfo;

use crate::state::AppState;

/// Most of an episode's start that's looked at for the intro (a share of it, at most this).
const INTRO_SHARE: f64 = 0.25;
const INTRO_MAX_SECS: f64 = 600.0;
/// How much of the end is looked at for the credits.
const CREDITS_SECS: f64 = 300.0;
/// An intro lasts 15 s to 2.5 min; credits at least 15 s.
const INTRO_LEN: (f64, f64) = (15.0, 150.0);
const CREDITS_LEN: (f64, f64) = (15.0, 600.0);
/// One fingerprint (minutes of sound off a network share) may take this long.
const FINGERPRINT_TIMEOUT: Duration = Duration::from_secs(120);
/// How often the library is looked at for seasons not checked yet (when nobody streams).
const CRAWL_EVERY: Duration = Duration::from_secs(60);
/// A season that couldn't be read (its share offline) waits this long before another try.
const RETRY_AFTER: Duration = Duration::from_secs(3600);

/// This ffmpeg fingerprints sound (set once at start).
static AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Seasons asked for by playback, first in line.
static WANTED: LazyLock<Mutex<VecDeque<SeasonKey>>> = LazyLock::new(Default::default);
static WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

/// The markers sent with a file's playback.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub(crate) struct ItemMarkers {
    #[serde(flatten)]
    pub markers: Markers,
    /// Its sound is still to be checked: ask again in a minute or two
    /// (`/api/items/{id}/markers`).
    pub pending: bool,
}

/// A file's markers: its named chapters, else what its sound gave.
pub(crate) async fn for_item(state: &AppState, item: &Item, media: &MediaInfo) -> ItemMarkers {
    let chapters = markers::from_chapters(&media.chapters, media.duration_secs.or(item.duration_secs));
    if item.kind != "episode" {
        return ItemMarkers { markers: chapters, pending: false };
    }
    let (audio, pending) = match state.db.audio_markers(item.id, item.size_bytes).await {
        Ok(Some(m)) => (
            Markers { intro_start: m.intro_start, intro_end: m.intro_end, credits_start: m.credits_start },
            false,
        ),
        _ => (Markers::default(), AVAILABLE.load(std::sync::atomic::Ordering::Relaxed)),
    };
    ItemMarkers { markers: chapters.or(audio), pending }
}

/// An episode starts playing: check its season soon, if it hasn't been.
pub(crate) fn want(item: &Item) {
    let (Some(series), Some(season)) = (item.series.clone(), item.season) else { return };
    let key = SeasonKey { library_id: item.library_id, series, season };
    let mut queue = WANTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !queue.contains(&key) {
        queue.push_back(key);
    }
    drop(queue);
    WAKE.notify_one();
}

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        if !markers::can_fingerprint(&state.ffmpeg).await {
            tracing::info!(
                "this ffmpeg can't fingerprint sound (no chromaprint): intros come from chapters only"
            );
            return;
        }
        AVAILABLE.store(true, std::sync::atomic::Ordering::Relaxed);
        let mut failed: HashMap<SeasonKey, Instant> = HashMap::new();
        loop {
            let wanted = WANTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front();
            let crawl = wanted.is_none();
            let next = match wanted {
                Some(key) => Some(key),
                None if idle(&state) => crawl_next(&state, &failed).await,
                None => None,
            };
            let Some(key) = next else {
                tokio::select! {
                    () = WAKE.notified() => {}
                    () = tokio::time::sleep(CRAWL_EVERY) => {}
                }
                continue;
            };
            match check_season(&state, &key, crawl).await {
                Ok(n) if n > 0 => tracing::info!(
                    series = key.series,
                    season = key.season,
                    episodes = n,
                    "checked intros and credits"
                ),
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(series = key.series, season = key.season, error = %e, "checking intros failed");
                    failed.insert(key, Instant::now());
                }
            }
        }
    });
}

/// Nobody is streaming something Panda makes (the crawl leaves the share and CPU to them).
fn idle(state: &AppState) -> bool {
    let c = state.sessions.counts();
    c.remux + c.hardware + c.software == 0
}

async fn crawl_next(state: &AppState, failed: &HashMap<SeasonKey, Instant>) -> Option<SeasonKey> {
    let seasons = state.db.unchecked_seasons(20).await.ok()?;
    seasons.into_iter().find(|k| failed.get(k).is_none_or(|at| at.elapsed() > RETRY_AFTER))
}

/// Someone is waiting for a season, or started streaming: the crawl makes way.
fn crawl_should_stop(state: &AppState) -> bool {
    !WANTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty() || !idle(state)
}

/// Check every episode of a season not checked yet; returns how many were. The crawl (`crawl`)
/// stops between episodes when it should make way; the rest is checked another time.
async fn check_season(state: &AppState, key: &SeasonKey, crawl: bool) -> anyhow::Result<usize> {
    let eps = state.db.season_episodes(key).await?;
    let mut todo = Vec::new();
    for (i, e) in eps.iter().enumerate() {
        if state.db.audio_markers(e.id, e.size_bytes).await?.is_none() {
            todo.push(i);
        }
    }
    if todo.is_empty() {
        return Ok(0);
    }
    let now = crate::services::settings::now();
    if eps.len() < 2 {
        // Nothing to compare with (yet): checked, nothing found. A second episode arriving
        // doesn't re-check it, which is fine for a one-episode season.
        for e in &eps {
            state.db.set_audio_markers(e.id, e.size_bytes, AudioMarkers::default(), now).await?;
        }
        return Ok(eps.len());
    }
    let mut prints = Prints::new(state);
    let mut done = 0;
    for &i in &todo {
        if crawl && crawl_should_stop(state) {
            break;
        }
        let e = &eps[i];
        // Its neighbours, nearest first: the next episode, the one before, then one further.
        let mut found = AudioMarkers::default();
        for j in [i + 1, i.wrapping_sub(1), i + 2, i.wrapping_sub(2)] {
            let Some(other) = eps.get(j) else { continue };
            if found.intro_start.is_none()
                && let Some(s) = compare(&mut prints, e, other, Part::Start).await?
            {
                found.intro_start = Some(s.a.0);
                found.intro_end = Some(s.a.1);
            }
            if found.credits_start.is_none()
                && let Some(s) = compare(&mut prints, e, other, Part::End).await?
            {
                found.credits_start = Some(end_window(e).0 + s.a.0);
            }
            if found.intro_start.is_some() && found.credits_start.is_some() {
                break;
            }
        }
        state.db.set_audio_markers(e.id, e.size_bytes, found, now).await?;
        done += 1;
    }
    Ok(done)
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Part {
    Start,
    End,
}

/// Where to look for the intro: (from, seconds).
fn start_window(e: &Item) -> (f64, f64) {
    start_of(e.duration_secs.unwrap_or(0.0))
}

fn end_window(e: &Item) -> (f64, f64) {
    end_of(e.duration_secs.unwrap_or(0.0))
}

fn start_of(duration: f64) -> (f64, f64) {
    (0.0, (duration * INTRO_SHARE).min(INTRO_MAX_SECS))
}

fn end_of(duration: f64) -> (f64, f64) {
    let from = (duration - CREDITS_SECS).max(duration * 0.5);
    (from, duration - from)
}

async fn compare(prints: &mut Prints<'_>, a: &Item, b: &Item, part: Part) -> anyhow::Result<Option<Shared>> {
    let (Some(pa), Some(pb)) = (prints.get(a, part).await?, prints.get(b, part).await?) else {
        return Ok(None);
    };
    let (min, max) = if part == Part::Start { INTRO_LEN } else { CREDITS_LEN };
    Ok(markers::shared(&pa, &pb, min, max))
}

/// Fingerprints of a season's episodes, read once (and kept in the cache for next time).
struct Prints<'a> {
    state: &'a AppState,
    have: HashMap<(i64, Part), Option<Vec<u32>>>,
}

impl<'a> Prints<'a> {
    fn new(state: &'a AppState) -> Self {
        Self { state, have: HashMap::new() }
    }

    /// The fingerprint of one part (`None`: the file has no sound, or too little to tell).
    /// An unreachable file is an error: the season is tried again later.
    async fn get(&mut self, e: &Item, part: Part) -> anyhow::Result<Option<Vec<u32>>> {
        if let Some(p) = self.have.get(&(e.id, part)) {
            return Ok(p.clone());
        }
        let print = self.read(e, part).await?;
        self.have.insert((e.id, part), print.clone());
        Ok(print)
    }

    async fn read(&self, e: &Item, part: Part) -> anyhow::Result<Option<Vec<u32>>> {
        let (from, secs) = if part == Part::Start { start_window(e) } else { end_window(e) };
        if secs < 30.0 {
            return Ok(None);
        }
        let cache = cache_path(&self.state.config.cache_dir(), e, part);
        if let Ok(bytes) = tokio::fs::read(&cache).await {
            return Ok(Some(markers::points(&bytes)));
        }
        if !reachable(&e.path).await {
            anyhow::bail!("{} isn't answering", e.path);
        }
        let run = markers::fingerprint(&self.state.ffmpeg, Path::new(&e.path), from, secs);
        let points = match tokio::time::timeout(FINGERPRINT_TIMEOUT, run).await {
            Ok(Ok(p)) => p,
            // A file without sound (or one ffmpeg can't read): nothing to find in it.
            Ok(Err(err)) => {
                tracing::debug!(path = e.path, error = %err, "fingerprinting failed");
                return Ok(None);
            }
            Err(_) => anyhow::bail!("fingerprinting {} timed out", e.path),
        };
        if let Some(dir) = cache.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let bytes: Vec<u8> = points.iter().flat_map(|p| p.to_le_bytes()).collect();
        let _ = tokio::fs::write(&cache, bytes).await;
        Ok(Some(points))
    }
}

fn cache_path(cache_dir: &Path, e: &Item, part: Part) -> PathBuf {
    let tag = if part == Part::Start { "start" } else { "end" };
    cache_dir.join("fingerprints").join(format!("{}-{}-{tag}.fp", e.id, e.size_bytes))
}

/// The file answers within a few seconds (a share that dropped would hang ffmpeg).
async fn reachable(path: &str) -> bool {
    let path = path.to_string();
    let check = tokio::task::spawn_blocking(move || std::fs::metadata(path).is_ok());
    matches!(tokio::time::timeout(Duration::from_secs(5), check).await, Ok(Ok(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cover_the_start_and_the_end() {
        assert_eq!(start_of(2700.0), (0.0, 600.0));
        assert_eq!(end_of(2700.0), (2400.0, 300.0));
        // A short cartoon: its first quarter, its second half at most.
        assert_eq!(start_of(420.0), (0.0, 105.0));
        assert_eq!(end_of(420.0), (210.0, 210.0));
    }
}
