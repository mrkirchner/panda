//! Direct play vs. transcode decision for a given client.

use serde::{Deserialize, Serialize};

use crate::probe::{DynamicRange, MediaInfo};
use crate::transcode::{self, AudioPlan, TranscodePlan, VideoCodec, VideoPlan};

/// What a client says it can play. Sent by the client on each playback request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientProfile {
    /// Canonical container names: `mp4`, `mkv`, `webm`, `mpegts`.
    pub containers: Vec<String>,
    /// ffprobe codec names: `h264`, `hevc`, `vp9`, `av1`.
    pub video_codecs: Vec<String>,
    /// ffprobe codec names: `aac`, `mp3`, `opus`, `ac3`, `eac3`, `flac`.
    pub audio_codecs: Vec<String>,
    pub max_height: u32,
    pub supports_hdr: bool,
    /// Dolby Vision decode + display. Without it, DV plays via its base layer or is tone mapped.
    #[serde(default)]
    pub supports_dolby_vision: bool,
    pub max_audio_channels: u32,
    /// Total stream budget (video + audio). `None` = no limit (play the original if possible).
    #[serde(default)]
    pub max_bitrate_kbps: Option<u32>,
}

impl Default for ClientProfile {
    /// Conservative profile any modern browser / TV can handle.
    fn default() -> Self {
        Self {
            containers: vec!["mp4".into()],
            video_codecs: vec!["h264".into()],
            audio_codecs: vec!["aac".into(), "mp3".into()],
            max_height: 1080,
            supports_hdr: false,
            supports_dolby_vision: false,
            max_audio_channels: 2,
            max_bitrate_kbps: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Decision {
    /// Serve the original file over HTTP range requests.
    DirectPlay,
    /// Run ffmpeg to HLS. `reasons` explains why direct play was rejected.
    Transcode { plan: TranscodePlan, reasons: Vec<String> },
}

/// Map ffprobe's `format_name` to a canonical container.
pub fn canonical_container(format_name: &str) -> &'static str {
    let first = format_name.split(',').next().unwrap_or_default();
    match first {
        "mov" | "mp4" | "m4a" => "mp4",
        "matroska" => "mkv",
        "webm" => "webm",
        "mpegts" => "mpegts",
        "avi" => "avi",
        _ => "unknown",
    }
}

/// MIME type for direct-playing a file in a given ffprobe container.
pub fn mime_type(format_name: &str) -> &'static str {
    match canonical_container(format_name) {
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mpegts" => "video/mp2t",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

fn mbps(kbps: u32) -> String {
    format!("{:.1} Mbps", f64::from(kbps) / 1000.0)
}

/// Most of a capped budget belongs to the picture.
const AUDIO_SHARE_PCT: u32 = 15;
const MIN_AUDIO_KBPS: u32 = 128;

/// Audio that's wasteful to send when bandwidth is limited (lossless or near-lossless).
fn heavy_audio(codec: &str) -> bool {
    matches!(codec, "truehd" | "mlp" | "flac" | "dts" | "alac") || codec.starts_with("pcm_")
}

/// Rough bitrate for copied audio when the container doesn't say.
fn audio_kbps_estimate(codec: &str, channels: u32) -> u32 {
    match codec {
        "aac" | "opus" | "mp3" => 64 * channels.clamp(2, 6),
        "ac3" | "eac3" => 640,
        _ => 1_500,
    }
}

pub fn decide(info: &MediaInfo, client: &ClientProfile, audio_index: Option<u32>) -> Decision {
    let mut reasons = Vec::new();
    let has = |list: &[String], v: &str| list.iter().any(|x| x.eq_ignore_ascii_case(v));

    let container = canonical_container(&info.container);
    if !has(&client.containers, container) {
        reasons.push(format!("container {container} not supported"));
    }

    // Bandwidth: the whole stream must fit the client's budget.
    let budget = client.max_bitrate_kbps;
    let source_kbps = info.bit_rate.map(|b| u32::try_from(b / 1000).unwrap_or(u32::MAX));
    let over_budget = matches!((budget, source_kbps), (Some(b), Some(s)) if s > b);
    if let (true, Some(b), Some(s)) = (over_budget, budget, source_kbps) {
        reasons.push(format!("{} exceeds the {} limit", mbps(s), mbps(b)));
    }

    let audio = match audio_index {
        Some(i) => info.audio.iter().find(|a| a.index == i),
        None => info.audio.iter().find(|a| a.default).or(info.audio.first()),
    };
    let audio_plan = match audio {
        None => AudioPlan::None,
        Some(a) => {
            let playable = has(&client.audio_codecs, &a.codec) && a.channels <= client.max_audio_channels;
            if !playable {
                reasons.push(format!("audio {} {}ch not supported", a.codec, a.channels));
            }
            // With a bandwidth cap, audio gets at most a share of it; bigger tracks become AAC
            // so the picture gets the bits.
            let audio_cap = budget.map(|b| (b.saturating_mul(AUDIO_SHARE_PCT) / 100).max(MIN_AUDIO_KBPS));
            let copy_kbps =
                a.bit_rate.map_or_else(|| audio_kbps_estimate(&a.codec, a.channels), |b| (b / 1000) as u32);
            let fits =
                audio_cap.is_none_or(|cap| copy_kbps <= cap && !(over_budget && heavy_audio(&a.codec)));
            if playable && fits {
                AudioPlan::Copy { index: a.index }
            } else {
                // ~96 kbps per channel: 192 stereo, 384 for 5.1, capped by the audio share.
                let mut channels = client.max_audio_channels.min(a.channels).max(1);
                let mut bitrate_kbps = (96 * channels).clamp(128, 384).min(audio_cap.unwrap_or(u32::MAX));
                if bitrate_kbps < 256 && channels > 2 {
                    channels = 2; // Surround squeezed below 256 kbps sounds worse than good stereo.
                    bitrate_kbps = bitrate_kbps.min(192);
                }
                AudioPlan::Aac { index: a.index, channels, bitrate_kbps }
            }
        }
    };
    let audio_kbps = match (audio_plan, audio) {
        (AudioPlan::Copy { .. }, Some(a)) => {
            a.bit_rate.map_or_else(|| audio_kbps_estimate(&a.codec, a.channels), |b| (b / 1000) as u32)
        }
        (AudioPlan::Aac { bitrate_kbps, .. }, _) => bitrate_kbps,
        _ => 0,
    };

    let video_plan = match &info.video {
        None => VideoPlan::None,
        Some(v) => {
            let codec_ok = has(&client.video_codecs, &v.codec);
            let height_ok = v.height <= client.max_height;
            let can_show = |r: DynamicRange| match r {
                DynamicRange::Sdr => true,
                DynamicRange::Hdr10 | DynamicRange::Hlg => client.supports_hdr,
                DynamicRange::DolbyVision => client.supports_dolby_vision,
            };
            // Dolby Vision 8.1/7 carry an HDR10 base layer and 8.2 an SDR one, so they play
            // as-is wherever that base layer can. Profile 5 has no fallback: tone map it.
            let base_layer = v.dovi.and_then(crate::probe::Dovi::base_layer);
            let hdr_ok = can_show(v.range)
                || (v.range == DynamicRange::DolbyVision && base_layer.is_some_and(can_show));
            if !codec_ok {
                reasons.push(format!("video codec {} not supported", v.codec));
            }
            if !height_ok {
                reasons.push(format!("{}p exceeds client max {}p", v.height, client.max_height));
            }
            if !hdr_ok {
                reasons.push(format!("{:?} needs tone mapping", v.range));
            }
            if codec_ok && height_ok && hdr_ok && !over_budget {
                VideoPlan::Copy
            } else {
                // HEVC gives the same quality at ~60% of H.264's bitrate; use it when possible.
                let codec =
                    if has(&client.video_codecs, "hevc") { VideoCodec::Hevc } else { VideoCodec::H264 };
                let max_height = v.height.min(client.max_height);
                let max_kbps = budget.map(|b| b.saturating_sub(audio_kbps).max(transcode::MIN_VIDEO_KBPS));
                let target_height = match max_kbps {
                    Some(kbps) => transcode::height_for_budget(kbps, codec, max_height),
                    None => max_height,
                };
                let bitrate_kbps =
                    transcode::video_bitrate_kbps(target_height, codec).min(max_kbps.unwrap_or(u32::MAX));
                // Encodes are SDR: tone map anything whose displayed layer is HDR.
                let shown = if v.range == DynamicRange::DolbyVision {
                    base_layer.unwrap_or(v.range)
                } else {
                    v.range
                };
                VideoPlan::Encode { target_height, tonemap: shown.is_hdr(), codec, bitrate_kbps, max_kbps }
            }
        }
    };

    if reasons.is_empty() {
        Decision::DirectPlay
    } else {
        Decision::Transcode { plan: TranscodePlan { video: video_plan, audio: audio_plan }, reasons }
    }
}

/// Pick which file of a title to play for this client, by what playing it would cost:
/// direct play, then remux, then transcode. Among direct/remux, the highest resolution wins.
/// Among transcodes, the smallest source that still covers the target wins (a 1080p file is
/// far cheaper to turn into 720p than a 4K Dolby Vision one). Returns the chosen `id`.
pub fn choose_version<K: Copy>(versions: &[(K, &MediaInfo)], client: &ClientProfile) -> Option<K> {
    let height = |m: &MediaInfo| m.video.as_ref().map_or(0, |v| v.height);
    versions
        .iter()
        .map(|(id, media)| {
            let (rank, target) = match decide(media, client, None) {
                Decision::DirectPlay => (0u8, height(media)),
                Decision::Transcode { plan: TranscodePlan { video: VideoPlan::Copy, .. }, .. } => {
                    (1, height(media))
                }
                Decision::Transcode {
                    plan: TranscodePlan { video: VideoPlan::Encode { target_height, .. }, .. },
                    ..
                } => (2, target_height),
                Decision::Transcode { .. } => (2, 0),
            };
            (*id, rank, target, height(media))
        })
        .min_by(|a, b| {
            a.1.cmp(&b.1).then_with(|| match a.1 {
                // Direct/remux: tallest first.
                0 | 1 => b.3.cmp(&a.3),
                // Transcode: best achievable output first, then the smallest source.
                _ => b.2.cmp(&a.2).then(a.3.cmp(&b.3)),
            })
        })
        .map(|(id, ..)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioStream, DynamicRange, VideoStream};

    fn info(container: &str, vcodec: &str, h: u32, range: DynamicRange, acodec: &str, ch: u32) -> MediaInfo {
        MediaInfo {
            version: 0,
            container: container.into(),
            duration_secs: Some(60.0),
            bit_rate: None,
            video: Some(VideoStream {
                index: 0,
                codec: vcodec.into(),
                profile: None,
                width: h * 16 / 9,
                height: h,
                pix_fmt: None,
                bit_depth: 8,
                frame_rate: Some(24.0),
                range,
                dovi: None,
            }),
            audio: vec![AudioStream {
                title: None,
                index: 1,
                codec: acodec.into(),
                channels: ch,
                bit_rate: None,
                language: None,
                default: true,
            }],
            subtitles: vec![],
            chapters: Vec::new(),
        }
    }

    #[test]
    fn mp4_h264_aac_direct_plays() {
        let i = info("mov,mp4,m4a,3gp,3g2,mj2", "h264", 1080, DynamicRange::Sdr, "aac", 2);
        assert!(matches!(decide(&i, &ClientProfile::default(), None), Decision::DirectPlay));
    }

    #[test]
    fn mkv_h264_is_remuxed_not_reencoded() {
        let i = info("matroska,webm", "h264", 1080, DynamicRange::Sdr, "aac", 2);
        let Decision::Transcode { plan, .. } = decide(&i, &ClientProfile::default(), None) else { panic!() };
        assert!(matches!(plan.video, VideoPlan::Copy));
        assert!(matches!(plan.audio, AudioPlan::Copy { index: 1 }));
    }

    #[test]
    fn dolby_vision_uses_its_base_layer_when_possible() {
        use crate::probe::Dovi;
        let hdr_client = ClientProfile {
            containers: vec!["mkv".into()],
            video_codecs: vec!["hevc".into()],
            audio_codecs: vec!["aac".into()],
            max_height: 2160,
            supports_hdr: true,
            ..ClientProfile::default()
        };
        let mut i = info("matroska,webm", "hevc", 2160, DynamicRange::DolbyVision, "aac", 2);
        let with = |i: &mut MediaInfo, profile, compat_id| {
            i.video.as_mut().unwrap().dovi = Some(Dovi { profile, compat_id });
        };
        // 8.1: HDR10 base layer plays directly on an HDR10 screen.
        with(&mut i, 8, 1);
        assert!(matches!(decide(&i, &hdr_client, None), Decision::DirectPlay));
        // Profile 5: no fallback, so it's tone mapped unless the client does Dolby Vision.
        with(&mut i, 5, 0);
        assert!(matches!(
            decide(&i, &hdr_client, None),
            Decision::Transcode {
                plan: TranscodePlan { video: VideoPlan::Encode { tonemap: true, .. }, .. },
                ..
            }
        ));
        let dv_client = ClientProfile { supports_dolby_vision: true, ..hdr_client.clone() };
        assert!(matches!(decide(&i, &dv_client, None), Decision::DirectPlay));
        // 8.1 on an SDR screen still needs tone mapping.
        with(&mut i, 8, 1);
        let sdr_client = ClientProfile { supports_hdr: false, ..hdr_client };
        assert!(matches!(decide(&i, &sdr_client, None), Decision::Transcode { .. }));
    }

    #[test]
    fn hdr_4k_hevc_gets_tonemapped_and_downscaled() {
        let i = info("matroska,webm", "hevc", 2160, DynamicRange::Hdr10, "eac3", 6);
        let Decision::Transcode { plan, reasons } = decide(&i, &ClientProfile::default(), None) else {
            panic!()
        };
        assert!(matches!(
            plan.video,
            VideoPlan::Encode {
                target_height: 1080,
                tonemap: true,
                codec: VideoCodec::H264,
                bitrate_kbps: 8000,
                ..
            }
        ));
        assert!(matches!(plan.audio, AudioPlan::Aac { index: 1, channels: 2, .. }));
        assert_eq!(reasons.len(), 5);
    }

    fn with_bitrate(mut i: MediaInfo, kbps: u64) -> MediaInfo {
        i.bit_rate = Some(kbps * 1000);
        i
    }

    fn capped(kbps: u32, hevc: bool) -> ClientProfile {
        ClientProfile {
            containers: vec!["mp4".into(), "mkv".into()],
            video_codecs: if hevc { vec!["h264".into(), "hevc".into()] } else { vec!["h264".into()] },
            audio_codecs: vec!["aac".into(), "ac3".into(), "eac3".into(), "truehd".into()],
            max_height: 2160,
            max_audio_channels: 6,
            max_bitrate_kbps: Some(kbps),
            ..ClientProfile::default()
        }
    }

    #[test]
    fn under_budget_still_direct_plays() {
        let i = with_bitrate(info("matroska,webm", "h264", 1080, DynamicRange::Sdr, "aac", 2), 6_000);
        assert!(matches!(decide(&i, &capped(8_000, false), None), Decision::DirectPlay));
    }

    #[test]
    fn over_budget_picks_the_tallest_rung_that_fits() {
        // A 26 Mbps 4K remux for a viewer with 10 Mbps: 1080p at the H.264 ladder rate.
        let i = with_bitrate(info("matroska,webm", "h264", 2160, DynamicRange::Sdr, "eac3", 6), 26_000);
        let Decision::Transcode { plan, reasons } = decide(&i, &capped(10_000, false), None) else {
            panic!()
        };
        assert!(reasons.iter().any(|r| r.contains("26.0 Mbps exceeds the 10.0 Mbps limit")), "{reasons:?}");
        assert!(matches!(plan.audio, AudioPlan::Copy { .. }), "E-AC-3 fits, keep it");
        let VideoPlan::Encode { target_height, codec, bitrate_kbps, .. } = plan.video else { panic!() };
        assert_eq!((target_height, codec, bitrate_kbps), (1080, VideoCodec::H264, 8_000));
    }

    #[test]
    fn hevc_clients_get_more_resolution_for_the_same_budget() {
        let i = with_bitrate(info("matroska,webm", "hevc", 2160, DynamicRange::Sdr, "aac", 2), 40_000);
        // 6 Mbps: H.264 only reaches 720p, HEVC fits 1080p (4.8 Mbps).
        let Decision::Transcode { plan: h264, .. } = decide(&i, &capped(6_000, false), None) else {
            panic!()
        };
        let Decision::Transcode { plan: hevc, .. } = decide(&i, &capped(6_000, true), None) else { panic!() };
        assert!(matches!(h264.video, VideoPlan::Encode { target_height: 720, codec: VideoCodec::H264, .. }));
        assert!(matches!(
            hevc.video,
            VideoPlan::Encode { target_height: 1080, codec: VideoCodec::Hevc, bitrate_kbps: 4_800, .. }
        ));
    }

    #[test]
    fn lossless_audio_is_converted_when_bandwidth_is_capped() {
        let i = with_bitrate(info("matroska,webm", "hevc", 2160, DynamicRange::Sdr, "truehd", 8), 60_000);
        let Decision::Transcode { plan, .. } = decide(&i, &capped(8_000, true), None) else { panic!() };
        assert!(matches!(plan.audio, AudioPlan::Aac { channels: 6, bitrate_kbps: 384, .. }));
        // Video budget = 8000 - 384 audio.
        assert!(matches!(plan.video, VideoPlan::Encode { max_kbps: Some(7_616), .. }));
    }

    #[test]
    fn tiny_budgets_get_the_lowest_rung() {
        let i = with_bitrate(info("matroska,webm", "h264", 1080, DynamicRange::Sdr, "aac", 2), 10_000);
        let Decision::Transcode { plan, .. } = decide(&i, &capped(500, false), None) else { panic!() };
        let VideoPlan::Encode { target_height, bitrate_kbps, .. } = plan.video else { panic!() };
        assert_eq!(target_height, 360);
        assert_eq!(bitrate_kbps, 372, "500 - 128 audio");
    }

    #[test]
    fn version_choice_prefers_direct_play_then_cheapest_transcode() {
        let uhd =
            with_bitrate(info("matroska,webm", "hevc", 2160, DynamicRange::DolbyVision, "truehd", 8), 60_000);
        let hd = with_bitrate(info("matroska,webm", "h264", 1080, DynamicRange::Sdr, "eac3", 6), 10_000);
        let versions = [(1, &uhd), (2, &hd)];

        // A 4K HDR/DV TV that plays everything natively: the 4K version.
        let tv_4k = ClientProfile {
            containers: vec!["mkv".into()],
            video_codecs: vec!["h264".into(), "hevc".into()],
            audio_codecs: vec!["truehd".into(), "eac3".into()],
            max_height: 2160,
            supports_hdr: true,
            supports_dolby_vision: true,
            max_audio_channels: 8,
            max_bitrate_kbps: None,
        };
        assert_eq!(choose_version(&versions, &tv_4k), Some(1));

        // A 1080p SDR browser: the HD file direct plays (no transcode at all).
        let browser = ClientProfile {
            supports_hdr: false,
            supports_dolby_vision: false,
            max_height: 1080,
            ..tv_4k.clone()
        };
        assert_eq!(choose_version(&versions, &browser), Some(2));

        // A slow remote viewer: both need a transcode; use the smaller HD source.
        let remote = ClientProfile { max_bitrate_kbps: Some(3_000), ..tv_4k };
        assert_eq!(choose_version(&versions, &remote), Some(2));
    }
}
