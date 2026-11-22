//! Preview clips: about 30 seconds cut from a title, for the TV's home hero and expanded cards.
//!
//! ffmpeg seeks straight to the start (`-ss` before `-i`, the container's index) and reads only
//! those seconds, so a clip costs a few hundred megabytes at most even from a remux on a network
//! share, never a pass over the whole file. The clip is 720p H.264 with stereo AAC in an MP4
//! whose index is at the front (`+faststart`), so every TV plays it progressively. HDR sources
//! are tone-mapped with the same software filter as transcodes. Subtitles are never included
//! (`-sn`): they're drawn by the client, never burned in.

use std::path::Path;

use tokio::process::Command;

use crate::caps::TonemapMethod;
use crate::ffmpeg::FfmpegPaths;
use crate::probe::MediaInfo;
use crate::transcode::software_tonemap_filter;
use crate::{Error, Result};

/// Clip length.
pub const CLIP_SECS: u32 = 30;
/// Clip height (never upscaled); width follows the aspect ratio.
pub const HEIGHT: u32 = 720;

/// Where the clip starts: a few minutes in (past logos and cold opens), 10% of the runtime
/// clamped to 1-10 minutes, and early enough to leave a whole clip. Short videos start at 0.
pub fn start_for(duration_secs: Option<f64>) -> u32 {
    let Some(d) = duration_secs.filter(|d| d.is_finite() && *d > 0.0) else { return 0 };
    let latest = d - f64::from(CLIP_SECS) - 5.0;
    if latest <= 0.0 {
        return 0;
    }
    (d * 0.1).clamp(60.0, 600.0).min(latest).floor() as u32
}

/// ffmpeg arguments that write the clip to `output` (an `.mp4` path).
pub fn clip_args(
    input: &Path,
    output: &Path,
    start_secs: u32,
    info: &MediaInfo,
    tonemap: Option<TonemapMethod>,
) -> Option<Vec<String>> {
    let v = info.video.as_ref()?;
    if v.width == 0 || v.height == 0 {
        return None;
    }
    // Never upscale; even dimensions for H.264.
    let height = (HEIGHT.min(v.height) + 1) & !1;
    let mut filters = vec![format!("scale=-2:{height}")];
    if v.range.is_hdr()
        && let Some(f) = tonemap.and_then(software_tonemap_filter)
    {
        filters.push(f.into());
    }
    filters.push("format=yuv420p".into());
    let audio = info.audio.iter().find(|a| a.default).or_else(|| info.audio.first());

    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        &start_secs.to_string(),
        "-i",
        &input.to_string_lossy(),
        "-t",
        &CLIP_SECS.to_string(),
        "-map",
        &format!("0:{}", v.index),
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    if let Some(a) = audio {
        args.extend(["-map".into(), format!("0:{}", a.index)]);
    }
    args.extend(
        [
            "-sn",
            "-dn",
            "-map_chapters",
            "-1",
            "-vf",
            &filters.join(","),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "26",
            "-profile:v",
            "high",
            "-level:v",
            "4.0",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            &output.to_string_lossy(),
        ]
        .iter()
        .map(ToString::to_string),
    );
    Some(args)
}

/// Make the clip at `output`.
pub async fn make(
    paths: &FfmpegPaths,
    input: &Path,
    output: &Path,
    start_secs: u32,
    info: &MediaInfo,
    tonemap: Option<TonemapMethod>,
) -> Result<()> {
    let args = clip_args(input, output, start_secs, info, tonemap)
        .ok_or_else(|| Error::Io(std::io::Error::other("no video stream")))?;
    let out = Command::new(&paths.ffmpeg)
        .args(&args)
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioStream, DynamicRange, VideoStream};

    fn info(width: u32, height: u32, range: DynamicRange) -> MediaInfo {
        let audio = |index, default| AudioStream {
            title: None,
            index,
            codec: "truehd".into(),
            channels: 8,
            bit_rate: None,
            language: Some("eng".into()),
            default,
        };
        MediaInfo {
            version: 0,
            container: "matroska,webm".into(),
            duration_secs: Some(7200.0),
            bit_rate: None,
            video: Some(VideoStream {
                index: 0,
                codec: "hevc".into(),
                profile: None,
                width,
                height,
                pix_fmt: None,
                bit_depth: 10,
                frame_rate: None,
                range,
                dovi: None,
            }),
            audio: vec![audio(1, false), audio(2, true)],
            subtitles: vec![],
        }
    }

    #[test]
    fn args_snapshot() {
        let i = info(1920, 1080, DynamicRange::Sdr);
        let a = clip_args(Path::new("/m/a.mkv"), Path::new("/c/1.mp4"), 600, &i, None).unwrap().join(" ");
        assert_eq!(
            a,
            "-hide_banner -nostdin -v error -y -ss 600 -i /m/a.mkv -t 30 -map 0:0 -map 0:2 -sn -dn \
             -map_chapters -1 -vf scale=-2:720,format=yuv420p -c:v libx264 -preset veryfast -crf 26 \
             -profile:v high -level:v 4.0 -c:a aac -ac 2 -b:a 96k -movflags +faststart -f mp4 /c/1.mp4"
        );
    }

    #[test]
    fn hdr_is_tone_mapped_and_small_videos_not_upscaled() {
        let hdr = info(3840, 2160, DynamicRange::Hdr10);
        let a =
            clip_args(Path::new("/m/a.mkv"), Path::new("/c/1.mp4"), 0, &hdr, Some(TonemapMethod::Tonemapx))
                .unwrap()
                .join(" ");
        assert!(a.contains("-vf scale=-2:720,tonemapx="), "{a}");
        let sd = info(720, 480, DynamicRange::Sdr);
        let a = clip_args(Path::new("/m/a.mkv"), Path::new("/c/1.mp4"), 0, &sd, None).unwrap().join(" ");
        assert!(a.contains("-vf scale=-2:480,format=yuv420p"), "{a}");
    }

    #[test]
    fn starts_a_few_minutes_in_leaving_a_whole_clip() {
        assert_eq!(start_for(Some(7200.0)), 600); // 10% capped at 10 minutes
        assert_eq!(start_for(Some(2700.0)), 270); // a 45-minute episode
        assert_eq!(start_for(Some(1320.0)), 132); // 22 minutes
        assert_eq!(start_for(Some(400.0)), 60); // at least a minute in
        assert_eq!(start_for(Some(80.0)), 45); // short: as late as still leaves 30 s
        assert_eq!(start_for(Some(20.0)), 0);
        assert_eq!(start_for(None), 0);
    }
}
