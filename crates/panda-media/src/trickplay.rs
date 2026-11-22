//! Scrub previews ("trickplay"): one small JPEG of the frame at a given time, made on demand.
//!
//! ffmpeg seeks straight to the time (`-ss` before `-i`, using the container's index), takes
//! the keyframe there (`-skip_frame nokey`, `-noaccurate_seek`) and scales it down, so a frame
//! costs a few megabytes of reading even from a big remux on a network share (about 1.5 s cold).
//! HDR sources are tone-mapped with the same software filter as transcodes so previews aren't
//! washed out.

use std::path::Path;

use tokio::process::Command;

use crate::caps::TonemapMethod;
use crate::ffmpeg::FfmpegPaths;
use crate::probe::MediaInfo;
use crate::transcode::software_tonemap_filter;
use crate::{Error, Result};

/// Previews are made (and cached) for every this many seconds; a request rounds down to it.
pub const STEP_SECS: u32 = 10;
/// Preview width; height follows the video's aspect ratio.
pub const WIDTH: u32 = 320;

/// The step a time falls in: previews are cached per step, so scrubbing nearby reuses them.
pub fn step_for(secs: f64) -> u32 {
    if secs.is_finite() && secs > 0.0 { (secs / f64::from(STEP_SECS)).floor() as u32 * STEP_SECS } else { 0 }
}

/// Preview size for this video: `WIDTH` wide, height by aspect ratio, rounded to even.
/// `None` without a video stream.
pub fn thumb_size(info: &MediaInfo) -> Option<(u32, u32)> {
    let v = info.video.as_ref()?;
    if v.width == 0 || v.height == 0 {
        return None;
    }
    let h = (f64::from(WIDTH) * f64::from(v.height) / f64::from(v.width)).round() as u32;
    Some((WIDTH, (h.max(2) + 1) & !1))
}

/// ffmpeg arguments that write one JPEG of the keyframe at `at_secs` to stdout.
pub fn frame_args(
    input: &Path,
    at_secs: u32,
    info: &MediaInfo,
    tonemap: Option<TonemapMethod>,
) -> Option<Vec<String>> {
    let (w, h) = thumb_size(info)?;
    let v = info.video.as_ref()?;
    let mut filters = vec![format!("scale={w}:{h}")];
    if v.range.is_hdr() {
        match tonemap.and_then(software_tonemap_filter) {
            Some(f) => filters.push(f.into()),
            None => filters.push("format=yuv420p".into()),
        }
    }
    // JPEG wants full-range YUV (ffmpeg's mjpeg encoder refuses TV range).
    filters.push("scale=out_range=full".into());
    filters.push("format=yuvj420p".into());
    Some(
        [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-skip_frame",
            "nokey",
            "-noaccurate_seek",
            "-ss",
            &at_secs.to_string(),
            "-i",
            &input.to_string_lossy(),
            "-map",
            &format!("0:{}", v.index),
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            &filters.join(","),
            "-q:v",
            "5",
            "-f",
            "mjpeg",
            "-",
        ]
        .iter()
        .map(ToString::to_string)
        .collect(),
    )
}

/// The preview JPEG for `at_secs` (already rounded with [`step_for`]).
pub async fn frame(
    paths: &FfmpegPaths,
    input: &Path,
    at_secs: u32,
    info: &MediaInfo,
    tonemap: Option<TonemapMethod>,
) -> Result<Vec<u8>> {
    let args = frame_args(input, at_secs, info, tonemap)
        .ok_or_else(|| Error::Io(std::io::Error::other("no video stream")))?;
    let out = Command::new(&paths.ffmpeg)
        .args(&args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|source| Error::Spawn { bin: paths.ffmpeg.display().to_string(), source })?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(Error::Failed {
            bin: "ffmpeg".into(),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{DynamicRange, VideoStream};

    fn info(width: u32, height: u32, range: DynamicRange, bit_depth: u8) -> MediaInfo {
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
                bit_depth,
                frame_rate: None,
                range,
                dovi: None,
            }),
            audio: vec![],
            subtitles: vec![],
        }
    }

    #[test]
    fn sdr_args_snapshot() {
        let a = frame_args(Path::new("/m/a.mkv"), 120, &info(1920, 1080, DynamicRange::Sdr, 8), None)
            .unwrap()
            .join(" ");
        assert_eq!(
            a,
            "-hide_banner -nostdin -v error -skip_frame nokey -noaccurate_seek -ss 120 -i /m/a.mkv \
             -map 0:0 -an -sn -dn -frames:v 1 -vf scale=320:180,scale=out_range=full,format=yuvj420p \
             -q:v 5 -f mjpeg -"
        );
    }

    #[test]
    fn hdr_is_tone_mapped_in_software() {
        let i = info(3840, 2160, DynamicRange::Hdr10, 10);
        let a = frame_args(Path::new("/m/a.mkv"), 0, &i, Some(TonemapMethod::Tonemapx)).unwrap().join(" ");
        assert!(a.contains("scale=320:180,tonemapx="), "{a}");
        // Hardware-only tone mapping can't run in this CPU chain: fall back to plain 8-bit.
        let a =
            frame_args(Path::new("/m/a.mkv"), 0, &i, Some(TonemapMethod::VideoToolbox)).unwrap().join(" ");
        assert!(a.contains("scale=320:180,format=yuv420p,scale=out_range=full"), "{a}");
    }

    #[test]
    fn size_follows_aspect_ratio_and_stays_even() {
        assert_eq!(thumb_size(&info(1920, 800, DynamicRange::Sdr, 8)), Some((320, 134)));
        assert_eq!(thumb_size(&info(1440, 1080, DynamicRange::Sdr, 8)), Some((320, 240)));
        let mut none = info(1920, 1080, DynamicRange::Sdr, 8);
        none.video = None;
        assert_eq!(thumb_size(&none), None);
    }

    #[test]
    fn times_round_down_to_steps() {
        assert_eq!(step_for(0.0), 0);
        assert_eq!(step_for(9.99), 0);
        assert_eq!(step_for(125.4), 120);
        assert_eq!(step_for(-3.0), 0);
        assert_eq!(step_for(f64::NAN), 0);
    }
}
