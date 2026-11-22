//! Running HLS sessions and transcode capacity.
//!
//! - Capacity: hardware encoders (e.g. the Apple media engine) and the CPU each have a
//!   comfortable number of simultaneous encodes. Every session holds a [`Ticket`] for its
//!   slot; the ticket is released when the session is dropped, however it ends, so the
//!   counts can't drift. Remuxes (`-c copy`) cost almost nothing and are never limited.
//! - Players don't reliably say goodbye (apps get killed, TVs sleep), so a reaper stops
//!   sessions nobody has fetched from recently. Otherwise abandoned ffmpeg processes would
//!   keep using the CPU/GPU and their slots.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use panda_media::transcode::TranscodeSession;
use serde::Serialize;
use tokio::sync::Mutex;

/// A session with no playlist/segment fetches for this long is stopped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const REAP_INTERVAL: Duration = Duration::from_secs(15);
const THROTTLE_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Slot {
    /// Container change / audio-only: video is copied.
    Remux,
    Hardware,
    Software,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct Limits {
    pub hardware: usize,
    pub software: usize,
    /// Pause ffmpeg when this many segments ahead of the viewer.
    pub ahead_segments: u32,
    /// Keep this many segments behind the viewer; older ones are deleted.
    pub keep_segments: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Throttle {
    Keep,
    Pause,
    Resume,
}

/// Pause when more than `ahead` segments are buffered past the viewer; resume below half.
/// The gap avoids flapping between paused and running.
pub(crate) fn throttle_decision(produced: u32, last_fetched: u32, paused: bool, ahead: u32) -> Throttle {
    let buffered = produced.saturating_sub(last_fetched + 1);
    match (paused, buffered) {
        (false, b) if b > ahead => Throttle::Pause,
        (true, b) if b <= ahead / 2 => Throttle::Resume,
        _ => Throttle::Keep,
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub(crate) struct Counts {
    pub remux: usize,
    pub hardware: usize,
    pub software: usize,
}

impl Counts {
    fn get_mut(&mut self, slot: Slot) -> &mut usize {
        match slot {
            Slot::Remux => &mut self.remux,
            Slot::Hardware => &mut self.hardware,
            Slot::Software => &mut self.software,
        }
    }
}

/// A reserved transcode slot. Dropping it frees the slot.
#[derive(Debug)]
pub(crate) struct Ticket {
    counts: Arc<StdMutex<Counts>>,
    pub slot: Slot,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut c = self.counts.lock().expect("counts lock poisoned");
        let n = c.get_mut(self.slot);
        *n = n.saturating_sub(1);
    }
}

/// What the admin dashboard shows about a stream.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StreamInfo {
    pub user_id: i64,
    pub item_id: i64,
    pub pipeline: &'static str,
    /// Human summary, e.g. "1080p HEVC 4.8 Mbps".
    pub output: String,
    pub started_at: u64,
}

/// Streams one user may have running at once; starting another stops their oldest.
pub(crate) const MAX_STREAMS_PER_USER: usize = 3;

#[derive(Debug)]
struct Active {
    session: TranscodeSession,
    info: StreamInfo,
    ticket: Ticket,
    last_access: Instant,
    /// Most recent segment the player fetched (its playhead, roughly).
    last_segment: u32,
    paused: bool,
    /// Segments below this index have been deleted.
    deleted_below: u32,
    produced: u32,
}

#[derive(Debug, Serialize)]
pub(crate) struct ActiveStream {
    pub id: String,
    pub slot: Slot,
    #[serde(flatten)]
    pub info: StreamInfo,
    pub idle_secs: u64,
    /// Throttled: far enough ahead of the viewer that ffmpeg is paused.
    pub paused: bool,
    /// Seconds transcoded beyond what the viewer has fetched.
    pub buffered_secs: u32,
}

#[derive(Debug)]
pub(crate) struct Sessions {
    inner: Mutex<HashMap<String, Active>>,
    counts: Arc<StdMutex<Counts>>,
    pub limits: Limits,
    /// Hardware encodes at once: `limits.hardware` at start, changeable from the admin UI.
    hardware: std::sync::atomic::AtomicUsize,
}

impl Sessions {
    pub(crate) fn new(limits: Limits) -> Self {
        let hardware = std::sync::atomic::AtomicUsize::new(limits.hardware);
        Self { inner: Mutex::default(), counts: Arc::default(), limits, hardware }
    }

    /// Hardware encodes allowed at once now.
    pub(crate) fn hardware_limit(&self) -> usize {
        self.hardware.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Change it (streams already running keep going; new ones follow the new limit).
    pub(crate) fn set_hardware_limit(&self, n: usize) {
        self.hardware.store(n.max(1), std::sync::atomic::Ordering::Relaxed);
    }

    /// Reserve a slot, or `None` if that kind of slot is full.
    pub(crate) fn try_reserve(&self, slot: Slot) -> Option<Ticket> {
        let mut c = self.counts.lock().expect("counts lock poisoned");
        let limit = match slot {
            Slot::Remux => usize::MAX,
            Slot::Hardware => self.hardware_limit(),
            Slot::Software => self.limits.software,
        };
        let n = c.get_mut(slot);
        if *n >= limit {
            return None;
        }
        *n += 1;
        Some(Ticket { counts: self.counts.clone(), slot })
    }

    pub(crate) fn counts(&self) -> Counts {
        *self.counts.lock().expect("counts lock poisoned")
    }

    pub(crate) async fn insert(
        &self,
        id: String,
        session: TranscodeSession,
        info: StreamInfo,
        ticket: Ticket,
    ) {
        let active = Active {
            session,
            info,
            ticket,
            last_access: Instant::now(),
            last_segment: 0,
            paused: false,
            deleted_below: 0,
            produced: 0,
        };
        let user = active.info.user_id;
        // A user's oldest streams make way past MAX_STREAMS_PER_USER: a viewer never needs more,
        // and looping "play" can't pile up ffmpegs (remuxes have no global cap).
        let evicted: Vec<Active> = {
            let mut map = self.inner.lock().await;
            map.insert(id.clone(), active);
            let mut mine: Vec<(String, Instant)> = map
                .iter()
                .filter(|(k, a)| a.info.user_id == user && **k != id)
                .map(|(k, a)| (k.clone(), a.last_access))
                .collect();
            mine.sort_by_key(|(_, at)| *at);
            let excess = (mine.len() + 1).saturating_sub(MAX_STREAMS_PER_USER);
            mine.into_iter().take(excess).filter_map(|(k, _)| map.remove(&k)).collect()
        };
        for a in evicted {
            tracing::info!(user_id = user, "stopping a stream over the per-user limit");
            a.session.stop().await;
        }
    }

    /// Segment directory for a session owned by `user_id`, marking it as in use. Fetching a
    /// media segment also records where the viewer is (for throttling and cleanup).
    pub(crate) async fn touch(&self, id: &str, user_id: i64, file: &str) -> Option<PathBuf> {
        let mut map = self.inner.lock().await;
        let active = map.get_mut(id).filter(|a| a.info.user_id == user_id)?;
        active.last_access = Instant::now();
        if let Some(n) = segment_index(file) {
            active.last_segment = n;
        }
        Some(active.session.dir.clone())
    }

    pub(crate) async fn list(&self) -> Vec<ActiveStream> {
        let map = self.inner.lock().await;
        let mut out: Vec<ActiveStream> = map
            .iter()
            .map(|(id, a)| ActiveStream {
                id: id.clone(),
                slot: a.ticket.slot,
                info: a.info.clone(),
                idle_secs: a.last_access.elapsed().as_secs(),
                paused: a.paused,
                buffered_secs: a.produced.saturating_sub(a.last_segment + 1)
                    * panda_media::transcode::SEGMENT_SECS,
            })
            .collect();
        out.sort_by_key(|s| s.info.started_at);
        out
    }

    /// Stop a session. `owner = Some(uid)` only stops it if that user started it.
    pub(crate) async fn stop(&self, id: &str, owner: Option<i64>) -> bool {
        let removed = {
            let mut map = self.inner.lock().await;
            match map.get(id) {
                Some(a) if owner.is_none_or(|o| o == a.info.user_id) => map.remove(id),
                _ => None,
            }
        };
        match removed {
            Some(a) => {
                a.session.stop().await;
                true
            }
            None => false,
        }
    }

    async fn reap(&self, idle: Duration) {
        let expired: Vec<Active> = {
            let mut map = self.inner.lock().await;
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, a)| a.last_access.elapsed() > idle)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        // Stop outside the lock: killing ffmpeg and deleting segments can take a moment.
        for a in expired {
            tracing::info!(dir = %a.session.dir.display(), "stopping idle transcode");
            a.session.stop().await;
        }
    }

    /// One throttling pass: pause/resume ffmpeg against each viewer's position and delete
    /// segments far behind it. Remuxes are throttled too: they read the source at disk speed.
    /// The lock is held only for bookkeeping: playlists are read and old segments deleted
    /// outside it, so segment requests (`touch`) never wait on the disk.
    async fn throttle(&self) {
        let playlists: Vec<(String, PathBuf)> = {
            let map = self.inner.lock().await;
            map.iter().map(|(id, a)| (id.clone(), a.session.playlist())).collect()
        };
        let mut produced = Vec::with_capacity(playlists.len());
        for (id, playlist) in playlists {
            let n = tokio::fs::read_to_string(playlist)
                .await
                .map_or(0, |t| u32::try_from(t.matches("#EXTINF").count()).unwrap_or(u32::MAX));
            produced.push((id, n));
        }

        let mut stale = Vec::new();
        {
            let mut map = self.inner.lock().await;
            for (id, n) in produced {
                // Stopped meanwhile: nothing to do.
                let Some(a) = map.get_mut(&id) else { continue };
                a.produced = n;
                if !a.session.finished() {
                    match throttle_decision(a.produced, a.last_segment, a.paused, self.limits.ahead_segments)
                    {
                        Throttle::Pause => {
                            a.session.pause();
                            a.paused = true;
                            tracing::debug!(dir = %a.session.dir.display(), "throttle: paused ffmpeg");
                        }
                        Throttle::Resume => {
                            a.session.resume();
                            a.paused = false;
                            tracing::debug!(dir = %a.session.dir.display(), "throttle: resumed ffmpeg");
                        }
                        Throttle::Keep => {}
                    }
                }
                let delete_to = a.last_segment.saturating_sub(self.limits.keep_segments);
                stale.extend((a.deleted_below..delete_to).map(|i| a.session.segment_path(i)));
                a.deleted_below = a.deleted_below.max(delete_to);
            }
        }
        for path in stale {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

/// `seg_00042.m4s` -> 42.
fn segment_index(file: &str) -> Option<u32> {
    file.strip_prefix("seg_")?.split('.').next()?.parse().ok()
}

pub(crate) fn spawn_throttle(sessions: Arc<Sessions>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(THROTTLE_INTERVAL);
        loop {
            tick.tick().await;
            sessions.throttle().await;
        }
    });
}

pub(crate) fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub(crate) fn spawn_reaper(sessions: Arc<Sessions>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(REAP_INTERVAL);
        loop {
            tick.tick().await;
            sessions.reap(IDLE_TIMEOUT).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_pauses_far_ahead_and_resumes_with_a_gap() {
        // 40 segments = 2 minutes at 3 s.
        assert_eq!(throttle_decision(10, 0, false, 40), Throttle::Keep);
        assert_eq!(throttle_decision(42, 0, false, 40), Throttle::Pause);
        assert_eq!(throttle_decision(42, 0, true, 40), Throttle::Keep, "stays paused while far ahead");
        assert_eq!(throttle_decision(42, 21, true, 40), Throttle::Resume, "resumes at half the window");
        assert_eq!(throttle_decision(42, 30, false, 40), Throttle::Keep);
    }

    #[test]
    fn parses_segment_names() {
        assert_eq!(segment_index("seg_00042.m4s"), Some(42));
        assert_eq!(segment_index("init.mp4"), None);
        assert_eq!(segment_index("index.m3u8"), None);
    }

    #[test]
    fn slots_are_limited_and_released_on_drop() {
        let s = Sessions::new(Limits { hardware: 1, software: 0, ahead_segments: 40, keep_segments: 40 });
        let hw = s.try_reserve(Slot::Hardware).expect("first hardware slot");
        assert!(s.try_reserve(Slot::Hardware).is_none(), "hardware full");
        assert!(s.try_reserve(Slot::Software).is_none(), "software disabled");
        let remuxes: Vec<_> = (0..50).map(|_| s.try_reserve(Slot::Remux).unwrap()).collect();
        assert_eq!(s.counts().remux, 50, "remux is never limited");
        drop(hw);
        drop(remuxes);
        assert_eq!(s.counts().hardware, 0);
        assert!(s.try_reserve(Slot::Hardware).is_some());
    }
}
