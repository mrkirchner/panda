//! `ffprobe` -> typed media info.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::ffmpeg::{self, FfmpegPaths};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicRange {
    Sdr,
    Hdr10,
    Hlg,
    DolbyVision,
}

impl DynamicRange {
    pub fn is_hdr(self) -> bool {
        self != DynamicRange::Sdr
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    /// What this analysis knows ([`PROBE_VERSION`] when made now); an older one is redone when
    /// the file plays. 0: from before versions (no track titles).
    #[serde(default)]
    pub version: u32,
    /// ffprobe `format_name`, e.g. `matroska,webm` or `mov,mp4,m4a,3gp,3g2,mj2`.
    pub container: String,
    pub duration_secs: Option<f64>,
    pub bit_rate: Option<u64>,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubtitleStream>,
}

/// The analysis version [`probe`] makes. 1: tracks' titles ("Forced French subtitles",
/// "Commentary"), and forced / SDH read from them when the flags aren't set.
pub const PROBE_VERSION: u32 = 1;

/// Whether a track's title says it's forced ("Forced French subtitles", "Signs & Songs").
fn title_says_forced(title: Option<&str>) -> bool {
    title.is_some_and(|t| {
        let t = t.to_lowercase();
        t.contains("forced") || t.contains("signs")
    })
}

/// Whether a track's title says it's for the deaf and hard of hearing.
fn title_says_sdh(title: Option<&str>) -> bool {
    title.is_some_and(|t| {
        let t = t.to_lowercase();
        t.contains("sdh")
            || t.contains("hearing impaired")
            || t.contains("hard of hearing")
            || t.split_whitespace().any(|w| w == "cc")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoStream {
    pub index: u32,
    pub codec: String,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: Option<String>,
    pub bit_depth: u8,
    pub frame_rate: Option<f64>,
    pub range: DynamicRange,
    /// Dolby Vision configuration, when present. `default` keeps older stored probes loading.
    #[serde(default)]
    pub dovi: Option<Dovi>,
}

/// Dolby Vision profile and base-layer compatibility (from the DOVI configuration record).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dovi {
    pub profile: u8,
    /// 0 = none (profile 5), 1 = HDR10, 2 = SDR, 4 = HLG, 6 = UHD Blu-ray (HDR10).
    pub compat_id: u8,
}

impl Dovi {
    /// What a non-Dolby-Vision display sees when it ignores the enhancement metadata.
    /// `None` means there is no usable base layer (profile 5: colors are wrong without DV).
    pub fn base_layer(self) -> Option<DynamicRange> {
        match self.compat_id {
            1 | 6 => Some(DynamicRange::Hdr10),
            2 => Some(DynamicRange::Sdr),
            4 => Some(DynamicRange::Hlg),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioStream {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    /// Bits per second, when the container reports it (MKV often doesn't).
    #[serde(default)]
    pub bit_rate: Option<u64>,
    pub language: Option<String>,
    pub default: bool,
    /// The track's title in the file ("Director's commentary"), when it has one.
    #[serde(default)]
    pub title: Option<String>,
}

/// A stream's dispositions are independent flags, as ffprobe reports them.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleStream {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
    pub default: bool,
    pub forced: bool,
    /// For the deaf and hard of hearing (SDH). Older stored probes lack it: false.
    #[serde(default)]
    pub hearing_impaired: bool,
    /// The track's title in the file ("Forced French subtitles"), when it has one.
    #[serde(default)]
    pub title: Option<String>,
    /// Text subs (srt/ass/webvtt) are converted to `WebVTT` and drawn by the client.
    /// Image subs (PGS/VobSub) are also drawn by the client as bitmaps. Panda never burns subtitles in.
    pub text_based: bool,
}

pub async fn probe(paths: &FfmpegPaths, file: &Path) -> Result<MediaInfo> {
    let file = file.to_string_lossy();
    let json = ffmpeg::run(
        &paths.ffprobe,
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &file],
    )
    .await?;
    parse(&json)
}

/// How far back to look for the keyframe before a seek target. Remux GOPs are usually a few
/// seconds; anything longer than this falls back to ffmpeg's own keyframe seek.
pub const KEYFRAME_WINDOW_SECS: f64 = 10.0;

/// ffprobe arguments listing video packets (time and flags) in the window before `at`. Reads
/// only that window (`-read_intervals`), so it's quick even on a network share.
pub fn keyframe_args(file: &Path, stream_index: u32, at: f64) -> Vec<String> {
    let from = (at - KEYFRAME_WINDOW_SECS).max(0.0);
    [
        "-v",
        "error",
        "-select_streams",
        &stream_index.to_string(),
        "-read_intervals",
        &format!("{from:.3}%{:.3}", at + 0.001),
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
        &file.to_string_lossy(),
    ]
    .iter()
    .map(ToString::to_string)
    .collect()
}

/// The last keyframe at or before `at` from `pts_time,flags` lines (`K` marks a keyframe).
pub fn last_keyframe(csv: &str, at: f64) -> Option<f64> {
    csv.lines()
        .filter_map(|l| {
            let (t, flags) = l.split_once(',')?;
            let t: f64 = t.trim().parse().ok()?;
            (flags.contains('K') && t <= at + 0.001 && at - t <= KEYFRAME_WINDOW_SECS).then_some(t)
        })
        .reduce(f64::max)
}

/// Where a copied (remuxed) video can actually start when seeking to `at`: the keyframe at or
/// before it. `None` if ffprobe found none in the window.
pub async fn keyframe_at_or_before(
    paths: &FfmpegPaths,
    file: &Path,
    stream_index: u32,
    at: f64,
) -> Result<Option<f64>> {
    let args = keyframe_args(file, stream_index, at);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let csv = ffmpeg::run(&paths.ffprobe, &refs).await?;
    Ok(last_keyframe(&csv, at))
}

pub fn parse(json: &str) -> Result<MediaInfo> {
    let raw: RawProbe = serde_json::from_str(json)?;
    let mut info = MediaInfo {
        version: PROBE_VERSION,
        container: raw.format.format_name.unwrap_or_default(),
        duration_secs: raw.format.duration.as_deref().and_then(|d| d.parse().ok()),
        bit_rate: raw.format.bit_rate.as_deref().and_then(|b| b.parse().ok()),
        video: None,
        audio: Vec::new(),
        subtitles: Vec::new(),
    };

    for s in raw.streams {
        let tags = s.tags.unwrap_or_default();
        let disp = s.disposition.unwrap_or_default();
        match s.codec_type.as_deref() {
            // First real video stream wins; skip cover art (attached_pic).
            Some("video") if info.video.is_none() && disp.attached_pic == 0 => {
                let range = dynamic_range(
                    s.color_transfer.as_deref(),
                    s.side_data_list.as_deref().unwrap_or_default(),
                );
                let bit_depth = s
                    .bits_per_raw_sample
                    .as_deref()
                    .and_then(|b| b.parse().ok())
                    .unwrap_or_else(|| bit_depth_from_pix_fmt(s.pix_fmt.as_deref()));
                info.video = Some(VideoStream {
                    index: s.index,
                    codec: s.codec_name.unwrap_or_default(),
                    profile: s.profile,
                    width: s.width.unwrap_or(0),
                    height: s.height.unwrap_or(0),
                    pix_fmt: s.pix_fmt,
                    bit_depth,
                    frame_rate: s.avg_frame_rate.as_deref().and_then(parse_ratio),
                    range,
                    dovi: s.side_data_list.as_deref().unwrap_or_default().iter().find_map(|d| {
                        Some(Dovi { profile: d.dv_profile?, compat_id: d.dv_bl_signal_compatibility_id? })
                    }),
                });
            }
            Some("audio") => info.audio.push(AudioStream {
                index: s.index,
                codec: s.codec_name.unwrap_or_default(),
                channels: s.channels.unwrap_or(2),
                bit_rate: s.bit_rate.as_deref().and_then(|b| b.parse().ok()),
                language: tags.language,
                default: disp.default == 1,
                title: tags.title,
            }),
            Some("subtitle") => {
                let codec = s.codec_name.unwrap_or_default();
                info.subtitles.push(SubtitleStream {
                    index: s.index,
                    text_based: matches!(
                        codec.as_str(),
                        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
                    ),
                    codec,
                    language: tags.language,
                    default: disp.default == 1,
                    forced: disp.forced == 1 || title_says_forced(tags.title.as_deref()),
                    hearing_impaired: disp.hearing_impaired == 1 || title_says_sdh(tags.title.as_deref()),
                    title: tags.title,
                });
            }
            _ => {}
        }
    }
    Ok(info)
}

fn dynamic_range(transfer: Option<&str>, side_data: &[RawSideData]) -> DynamicRange {
    let dovi = side_data.iter().any(|d| d.side_data_type.as_deref() == Some("DOVI configuration record"));
    if dovi {
        return DynamicRange::DolbyVision;
    }
    match transfer {
        Some("smpte2084") => DynamicRange::Hdr10,
        Some("arib-std-b67") => DynamicRange::Hlg,
        _ => DynamicRange::Sdr,
    }
}

fn bit_depth_from_pix_fmt(pix_fmt: Option<&str>) -> u8 {
    match pix_fmt {
        Some(p) if p.contains("p10") => 10,
        Some(p) if p.contains("p12") => 12,
        _ => 8,
    }
}

fn parse_ratio(r: &str) -> Option<f64> {
    let (n, d) = r.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d != 0.0).then(|| n / d)
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: RawFormat,
}

#[derive(Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Deserialize)]
struct RawStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    bits_per_raw_sample: Option<String>,
    avg_frame_rate: Option<String>,
    color_transfer: Option<String>,
    channels: Option<u32>,
    bit_rate: Option<String>,
    side_data_list: Option<Vec<RawSideData>>,
    tags: Option<RawTags>,
    disposition: Option<RawDisposition>,
}

#[derive(Deserialize)]
struct RawSideData {
    side_data_type: Option<String>,
    dv_profile: Option<u8>,
    dv_bl_signal_compatibility_id: Option<u8>,
}

#[derive(Deserialize, Default)]
struct RawTags {
    language: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    default: u8,
    #[serde(default)]
    forced: u8,
    #[serde(default)]
    attached_pic: u8,
    #[serde(default)]
    hearing_impaired: u8,
}

#[cfg(test)]
mod tests {

    #[test]
    fn track_titles_mark_forced_and_sdh() {
        assert!(title_says_forced(Some("Forced French subtitles")));
        assert!(title_says_forced(Some("Signs & Songs")));
        assert!(!title_says_forced(Some("French subtitles")));
        assert!(title_says_sdh(Some("English SDH")));
        assert!(title_says_sdh(Some("English (CC)".replace(['(', ')'], " ").as_str())));
        assert!(!title_says_sdh(Some("Occasional")));
        assert!(!title_says_forced(None));
    }

    #[test]
    fn finds_the_keyframe_at_or_before_the_target() {
        let csv = "100.000,K__\n101.001,___\n104.004,K__\n106.000,___\n";
        assert_eq!(last_keyframe(csv, 105.0), Some(104.004));
        assert_eq!(last_keyframe(csv, 104.004), Some(104.004), "exactly on a keyframe");
        assert_eq!(last_keyframe(csv, 103.0), Some(100.0));
        assert_eq!(last_keyframe("", 50.0), None);
        // Too far back to be the one ffmpeg would use: let ffmpeg decide.
        assert_eq!(last_keyframe("10.000,K__\n", 50.0), None);
    }

    #[test]
    fn keyframe_probe_reads_only_a_window() {
        let a = keyframe_args(Path::new("/m/a.mkv"), 0, 125.0).join(" ");
        assert!(a.contains("-select_streams 0 -read_intervals 115.000%125.001"), "{a}");
        let a = keyframe_args(Path::new("/m/a.mkv"), 0, 5.0).join(" ");
        assert!(a.contains("-read_intervals 0.000%5.001"), "{a}");
    }

    use super::*;

    const HDR10_MKV: &str = r#"{
      "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "hevc", "profile": "Main 10",
         "width": 3840, "height": 2160, "pix_fmt": "yuv420p10le", "avg_frame_rate": "24000/1001",
         "color_transfer": "smpte2084", "disposition": {"default": 1, "forced": 0, "attached_pic": 0}},
        {"index": 1, "codec_type": "audio", "codec_name": "eac3", "channels": 6,
         "tags": {"language": "eng"}, "disposition": {"default": 1, "forced": 0}},
        {"index": 2, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle",
         "tags": {"language": "eng"}, "disposition": {"default": 0, "forced": 1}},
        {"index": 3, "codec_type": "subtitle", "codec_name": "subrip",
         "tags": {"language": "spa"}, "disposition": {"default": 0, "forced": 0}}
      ],
      "format": {"format_name": "matroska,webm", "duration": "7265.123000", "bit_rate": "25000000"}
    }"#;

    #[test]
    fn parses_hdr10_movie() {
        let info = parse(HDR10_MKV).unwrap();
        let v = info.video.unwrap();
        assert_eq!((v.codec.as_str(), v.width, v.height, v.bit_depth), ("hevc", 3840, 2160, 10));
        assert_eq!(v.range, DynamicRange::Hdr10);
        assert!((v.frame_rate.unwrap() - 23.976).abs() < 0.01);
        assert_eq!(info.audio[0].channels, 6);
        assert!(!info.subtitles[0].text_based && info.subtitles[0].forced);
        assert!(info.subtitles[1].text_based);
        assert_eq!(info.duration_secs, Some(7265.123));
    }

    #[test]
    fn detects_dolby_vision() {
        let json = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"hevc",
          "width":3840,"height":2160,"color_transfer":"smpte2084",
          "side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8,
            "dv_bl_signal_compatibility_id":1}]}],
          "format":{"format_name":"mov,mp4"}}"#;
        let v = parse(json).unwrap().video.unwrap();
        assert_eq!(v.range, DynamicRange::DolbyVision);
        assert_eq!(v.dovi, Some(Dovi { profile: 8, compat_id: 1 }));
        assert_eq!(v.dovi.unwrap().base_layer(), Some(DynamicRange::Hdr10));
        assert_eq!(Dovi { profile: 5, compat_id: 0 }.base_layer(), None);
    }
}
