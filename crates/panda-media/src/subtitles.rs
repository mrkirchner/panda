//! Subtitle extraction for client-side overlay rendering.
//!
//! Policy: Panda never burns subtitles into video. Text tracks are served as `WebVTT` and the
//! client draws them on top of the video. Image tracks (PGS/VobSub) will be served as bitmap
//! cues for the client to draw (not implemented yet).

use std::path::Path;

use tokio::process::Command;

use crate::ffmpeg::FfmpegPaths;
use crate::probe::{MediaInfo, SubtitleStream};
use crate::{Error, Result};

pub fn find_text_track(info: &MediaInfo, index: u32) -> Option<&SubtitleStream> {
    info.subtitles.iter().find(|s| s.index == index && s.text_based)
}

pub fn webvtt_args(input: &Path, index: u32) -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        &input.to_string_lossy(),
        "-map",
        &format!("0:{index}"),
        "-c:s",
        "webvtt",
        "-f",
        "webvtt",
        "-",
    ]
    .iter()
    .map(std::string::ToString::to_string)
    .collect()
}

/// One stretch of a text subtitle stream, `from`..`to` seconds, as `WebVTT` with the file's own
/// times. Seeks first (`-ss` before `-i`), so it reads only that part of the file: under a second
/// even from a network share, where a whole-file pass can take minutes.
pub fn webvtt_window_args(input: &Path, index: u32, from: u32, to: u32) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-v", "error", "-ss"]
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    a.extend([from.to_string(), "-copyts".into(), "-i".into(), input.to_string_lossy().into_owned()]);
    a.extend(["-to".into(), to.to_string(), "-map".into(), format!("0:{index}")]);
    a.extend(["-c:s", "webvtt", "-f", "webvtt", "-"].iter().map(std::string::ToString::to_string));
    a
}

/// Extract a stretch of a text subtitle stream (see [`webvtt_window_args`]).
pub async fn extract_webvtt_window(
    paths: &FfmpegPaths,
    input: &Path,
    index: u32,
    from: u32,
    to: u32,
) -> Result<String> {
    run_webvtt(paths, webvtt_window_args(input, index, from, to)).await
}

/// Extract one text subtitle stream as a `WebVTT` document.
/// ASS styling is flattened to plain text. Rendering styled ASS is a later client feature.
pub async fn extract_webvtt(paths: &FfmpegPaths, input: &Path, index: u32) -> Result<String> {
    run_webvtt(paths, webvtt_args(input, index)).await
}

async fn run_webvtt(paths: &FfmpegPaths, args: Vec<String>) -> Result<String> {
    let out = Command::new(&paths.ffmpeg)
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|source| Error::Spawn { bin: paths.ffmpeg.display().to_string(), source })?;
    if !out.status.success() {
        return Err(Error::Failed {
            bin: "ffmpeg".into(),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_args_seek_before_input_and_keep_file_times() {
        let a = webvtt_window_args(Path::new("/m/a.mkv"), 4, 1800, 2400).join(" ");
        assert!(a.contains("-ss 1800 -copyts -i /m/a.mkv -to 2400 -map 0:4 -c:s webvtt -f webvtt -"), "{a}");
    }

    #[test]
    fn webvtt_args_map_single_stream() {
        let a = webvtt_args(Path::new("/m/a.mkv"), 3).join(" ");
        assert!(a.ends_with("-i /m/a.mkv -map 0:3 -c:s webvtt -f webvtt -"));
    }
}
