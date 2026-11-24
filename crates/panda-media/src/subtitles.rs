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

/// `vtt` with every cue moved `secs` earlier (later when negative): for a player whose clock
/// doesn't start at the file's start (a stream begun mid-file) or whose viewer set a timing.
/// Cues that would end before 0 are dropped; ones that start before 0 start at 0.
#[must_use]
pub fn shift_webvtt(vtt: &str, secs: f64) -> String {
    use std::fmt::Write as _;
    if secs == 0.0 {
        return vtt.to_string();
    }
    let mut out = String::with_capacity(vtt.len());
    let mut skipping = false;
    for line in vtt.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        if let Some((start, rest)) = text.split_once(" --> ") {
            let (end, settings) = rest.split_once(' ').map_or((rest, ""), |(e, s)| (e, s));
            if let (Some(a), Some(b)) = (parse_vtt_time(start), parse_vtt_time(end)) {
                let (a, b) = (a - secs, b - secs);
                skipping = b <= 0.0;
                if skipping {
                    // The cue's id line (if any) was already written; it's harmless on its own.
                    continue;
                }
                let tail = if settings.is_empty() { String::new() } else { format!(" {settings}") };
                let _ = writeln!(out, "{} --> {}{tail}", format_vtt_time(a.max(0.0)), format_vtt_time(b));
                continue;
            }
        }
        if skipping {
            // The dropped cue's text runs to the next blank line.
            if text.is_empty() {
                skipping = false;
                out.push_str(line);
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

/// "01:02:03.456" or "02:03.456" -> seconds.
fn parse_vtt_time(s: &str) -> Option<f64> {
    let mut parts: Vec<&str> = s.trim().split(':').collect();
    let secs: f64 = parts.pop()?.parse().ok()?;
    let mins: f64 = parts.pop().map_or(Ok(0.0), str::parse).ok()?;
    let hours: f64 = parts.pop().map_or(Ok(0.0), str::parse).ok()?;
    Some(hours * 3600.0 + mins * 60.0 + secs)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn format_vtt_time(secs: f64) -> String {
    let ms = (secs * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

#[cfg(test)]
mod shift_tests {
    use super::*;

    #[test]
    fn cues_move_and_ones_before_the_start_go() {
        let vtt = "WEBVTT\n\n1\n00:00:10.000 --> 00:00:12.000\nGone\n\n2\n00:40:01.500 --> 00:40:03.000 line:90%\nHere\n\n00:39:59.000 --> 00:40:02.000\nStraddles\n";
        let out = shift_webvtt(vtt, 2400.0);
        assert!(!out.contains("Gone"), "{out}");
        assert!(out.contains("00:00:01.500 --> 00:00:03.000 line:90%\nHere"), "{out}");
        assert!(out.contains("00:00:00.000 --> 00:00:02.000\nStraddles"), "{out}");
        assert!(out.starts_with("WEBVTT\n"));
        // A negative shift (a viewer's later timing) moves cues later.
        assert!(shift_webvtt("00:01.000 --> 00:02.000\nx\n", -1.5).contains("00:00:02.500 --> 00:00:03.500"));
        assert_eq!(shift_webvtt(vtt, 0.0), vtt);
    }
}
