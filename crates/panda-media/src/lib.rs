//! `FFmpeg` integration for Panda.
//!
//! Panda never links against `FFmpeg`. It runs `ffmpeg`/`ffprobe` as subprocesses,
//! which keeps Panda's own license independent of `FFmpeg`'s (jellyfin-ffmpeg is GPL-3.0)
//! and lets users swap binaries freely.
//!
//! - [`ffmpeg`]: locate the binaries, preferring jellyfin-ffmpeg.
//! - [`caps`]: probe what the binary + this machine can actually do (hwaccel, tone mapping).
//! - [`probe`]: `ffprobe` a file into a typed [`probe::MediaInfo`].
//! - [`playback`]: decide direct play vs. transcode for a given client.
//! - [`transcode`]: build ffmpeg HLS command lines and manage running sessions.
//! - [`pgs`]: decode Blu-ray PGS subtitles into bitmap cues (PNG) for overlay rendering.
//! - [`subtitles`]: extract text subtitles as `WebVTT` for client-side overlay rendering.
//! - [`sidecar`]: subtitle files next to a video (`Movie.en.srt`), converted the same way.
//! - [`trickplay`]: scrub-preview thumbnail sheets.
//!
//! Subtitles are never burned into video. Transcodes always drop subtitle streams (`-sn`)
//! and clients render subtitles as an overlay.

pub mod caps;
pub mod clip;
pub mod ffmpeg;
pub mod pgs;
pub mod playback;
pub mod probe;
pub mod sidecar;
pub mod subtitles;
pub mod transcode;
pub mod trickplay;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ffmpeg binary not found (looked in: {0})")]
    NotFound(String),
    #[error("failed to run {bin}: {source}")]
    Spawn {
        bin: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{bin} exited with {status}: {stderr}")]
    Failed { bin: String, status: std::process::ExitStatus, stderr: String },
    #[error("could not parse ffprobe output: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("timed out waiting for {0}")]
    Timeout(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
