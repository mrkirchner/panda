//! HLS transcoding: plan -> ffmpeg arguments -> running session.
//!
//! The argument builder is pure so it can be snapshot-tested. Hardware pipelines plug in via
//! [`HwPipeline`]; only [`Software`] exists today. When porting Jellyfin's
//! `MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs`, add one impl per accelerator and
//! keep frames on the GPU from decode -> scale/tonemap -> encode.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::caps::{Capabilities, HwAccel, TonemapMethod};
use crate::ffmpeg::FfmpegPaths;
use crate::probe::MediaInfo;
use crate::{Error, Result};

pub const PLAYLIST: &str = "index.m3u8";
/// fMP4 initialization segment, written next to the playlist.
pub const INIT_SEGMENT: &str = "init.mp4";

/// Output video codec for transcodes. Encodes are always 8-bit SDR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
    /// ~40% smaller than H.264 at the same quality. Tagged `hvc1` for Apple/TV compatibility.
    Hevc,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum VideoPlan {
    None,
    Copy,
    Encode {
        target_height: u32,
        tonemap: bool,
        codec: VideoCodec,
        bitrate_kbps: u32,
        /// Video share of the client's bandwidth budget, if it set one.
        #[serde(skip_serializing_if = "Option::is_none")]
        max_kbps: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AudioPlan {
    None,
    Copy { index: u32 },
    Aac { index: u32, channels: u32, bitrate_kbps: u32 },
}

/// Quality ladder: (height, H.264 kbps). HEVC uses 60% of these.
const LADDER: [(u32, u32); 6] =
    [(2160, 20_000), (1440, 12_000), (1080, 8_000), (720, 4_000), (480, 2_000), (360, 1_000)];

/// Below this, video is unwatchable; budgets smaller than this still get it.
pub const MIN_VIDEO_KBPS: u32 = 300;

/// Target video bitrate for an output height and codec.
pub fn video_bitrate_kbps(height: u32, codec: VideoCodec) -> u32 {
    let h264 = LADDER.iter().find(|(h, _)| height >= *h).map_or(LADDER[LADDER.len() - 1].1, |(_, k)| *k);
    match codec {
        VideoCodec::H264 => h264,
        VideoCodec::Hevc => h264 * 3 / 5,
    }
}

/// Tallest ladder step (not above `max_height`) whose bitrate fits `budget_kbps`.
/// Falls back to the smallest step when even that doesn't fit.
pub fn height_for_budget(budget_kbps: u32, codec: VideoCodec, max_height: u32) -> u32 {
    let fits = LADDER
        .iter()
        .map(|(h, _)| (*h).min(max_height))
        .find(|h| video_bitrate_kbps(*h, codec) <= budget_kbps);
    fits.unwrap_or(LADDER[LADDER.len() - 1].0.min(max_height))
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct TranscodePlan {
    pub video: VideoPlan,
    pub audio: AudioPlan,
}

#[derive(Debug, Clone)]
pub struct HlsOptions {
    pub segment_secs: u32,
    pub start_secs: f64,
}

/// Segment length. 3 s cut time-to-first-segment by ~30% vs 6 s on an M4 (`VideoToolbox`
/// 1148 -> 800 ms, software 1389 -> 1009 ms); 2 s only saved ~100 ms more for 50% more
/// playlist entries. (ffmpeg can't do short-then-long segments in event playlists.)
pub const SEGMENT_SECS: u32 = 3;

impl Default for HlsOptions {
    fn default() -> Self {
        Self { segment_secs: SEGMENT_SECS, start_secs: 0.0 }
    }
}

/// One video processing backend (software, VAAPI, QSV, NVENC, `VideoToolbox`, ...).
pub trait HwPipeline: Send + Sync {
    fn name(&self) -> &'static str;
    /// Arguments placed before `-i` (hw device init, `-hwaccel ...`).
    fn decode_args(&self, info: &MediaInfo) -> Vec<String>;
    /// `-vf` filter chain for scaling/tone mapping, or `None` if no filtering is needed.
    fn filter_chain(&self, info: &MediaInfo, target_height: u32, tonemap: bool) -> Option<String>;
    /// Encoder arguments (`-c:v ...` and rate control).
    fn encode_args(&self, codec: VideoCodec, bitrate_kbps: u32) -> Vec<String>;
    /// Whether this pipeline can encode `codec`.
    fn supports(&self, codec: VideoCodec) -> bool;
}

/// CPU pipeline: libx264/libx265 + `tonemapx` (jellyfin-ffmpeg) or `zscale`+`tonemap` (stock).
#[derive(Debug, Clone, Copy)]
pub struct Software {
    pub tonemap: Option<TonemapMethod>,
    /// libx265 is available.
    pub hevc: bool,
}

impl Software {
    pub fn from_caps(caps: &Capabilities) -> Self {
        Self { tonemap: caps.software_tonemap(), hevc: caps.has_encoder("libx265") }
    }
}

impl HwPipeline for Software {
    fn name(&self) -> &'static str {
        "software"
    }

    fn decode_args(&self, _info: &MediaInfo) -> Vec<String> {
        Vec::new()
    }

    fn filter_chain(&self, info: &MediaInfo, target_height: u32, tonemap: bool) -> Option<String> {
        let v = info.video.as_ref()?;
        let mut chain: Vec<String> = Vec::new();
        let (w, h) = fit_within(v.width, v.height, target_height);
        if (w, h) != (v.width, v.height) {
            chain.push(format!("scale={w}:{h}"));
        }
        match (tonemap, self.tonemap.and_then(software_tonemap_filter)) {
            (true, Some(filter)) => chain.push(filter.into()),
            (true, None) => {
                tracing::warn!(
                    "HDR source but no software tone mapper available; colors will look washed out"
                );
                chain.push("format=yuv420p".into());
            }
            (false, _) if v.bit_depth > 8 => chain.push("format=yuv420p".into()),
            (false, _) => {}
        }
        (!chain.is_empty()).then(|| chain.join(","))
    }

    fn encode_args(&self, codec: VideoCodec, bitrate_kbps: u32) -> Vec<String> {
        // Capped CRF: constant quality, never above the bitrate the client can take.
        let (rate, buf) = (format!("{bitrate_kbps}k"), format!("{}k", bitrate_kbps * 2));
        match codec {
            VideoCodec::H264 => args(&[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-profile:v",
                "high",
                "-maxrate",
                &rate,
                "-bufsize",
                &buf,
                "-sc_threshold",
                "0",
            ]),
            VideoCodec::Hevc => args(&[
                "-c:v",
                "libx265",
                "-preset",
                "superfast",
                "-crf",
                "26",
                "-maxrate",
                &rate,
                "-bufsize",
                &buf,
                "-x265-params",
                "log-level=error",
                "-tag:v",
                "hvc1",
            ]),
        }
    }

    fn supports(&self, codec: VideoCodec) -> bool {
        codec == VideoCodec::H264 || self.hevc
    }
}

/// Apple `VideoToolbox` (macOS): hardware decode, `scale_vt`, Metal tone mapping
/// (`tonemap_videotoolbox`, jellyfin-ffmpeg) and the hardware H.264 encoder. Frames stay on the
/// media engine end to end. Measured on an M4 for 4K HDR to 1080p SDR: ~50-70x less CPU and
/// over 2x faster than [`Software`].
#[derive(Debug, Clone, Copy)]
pub struct VideoToolbox {
    /// `tonemap_videotoolbox` is available (jellyfin-ffmpeg builds only).
    pub tonemap: bool,
    /// `hevc_videotoolbox` is available.
    pub hevc: bool,
}

impl VideoToolbox {
    /// Codecs Apple silicon decodes in hardware. Anything else is decoded on the CPU and
    /// still encoded in hardware.
    fn hw_decodes(info: &MediaInfo) -> bool {
        info.video.as_ref().is_some_and(|v| matches!(v.codec.as_str(), "h264" | "hevc" | "av1" | "vp9"))
    }
}

impl HwPipeline for VideoToolbox {
    fn name(&self) -> &'static str {
        "videotoolbox"
    }

    fn decode_args(&self, info: &MediaInfo) -> Vec<String> {
        if Self::hw_decodes(info) {
            args(&["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"])
        } else {
            Vec::new()
        }
    }

    fn filter_chain(&self, info: &MediaInfo, target_height: u32, tonemap: bool) -> Option<String> {
        let v = info.video.as_ref()?;
        let (w, h) = fit_within(v.width, v.height, target_height);
        let resize = (w, h) != (v.width, v.height);
        if !Self::hw_decodes(info) {
            // CPU frames: scale in software; the hardware encoder accepts them directly.
            return resize.then(|| format!("scale={w}:{h},format=nv12"));
        }
        let mut chain = Vec::new();
        if resize {
            chain.push(format!("scale_vt=w={w}:h={h}"));
        }
        if tonemap && self.tonemap {
            // Applies Dolby Vision RPU metadata when present (apply_dovi defaults to on).
            chain.push(
                "tonemap_videotoolbox=format=nv12:tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709"
                    .into(),
            );
        }
        // 10-bit hardware frames go straight into the encoder, which converts to 8-bit itself.
        (!chain.is_empty()).then(|| chain.join(","))
    }

    fn encode_args(&self, codec: VideoCodec, bitrate_kbps: u32) -> Vec<String> {
        // VideoToolbox has no CRF; use a capped average bitrate like other hardware encoders.
        let (rate, buf) = (format!("{bitrate_kbps}k"), format!("{}k", bitrate_kbps * 2));
        match codec {
            VideoCodec::H264 => args(&[
                "-c:v",
                "h264_videotoolbox",
                "-profile:v",
                "high",
                "-b:v",
                &rate,
                "-maxrate",
                &rate,
                "-bufsize",
                &buf,
            ]),
            VideoCodec::Hevc => args(&[
                "-c:v",
                "hevc_videotoolbox",
                "-profile:v",
                "main",
                "-tag:v",
                "hvc1",
                "-b:v",
                &rate,
                "-maxrate",
                &rate,
                "-bufsize",
                &buf,
            ]),
        }
    }

    fn supports(&self, codec: VideoCodec) -> bool {
        codec == VideoCodec::H264 || self.hevc
    }
}

/// Pick the best pipeline for this job. Hardware when it's available and can do everything
/// the plan needs; software when only software can produce correct colors.
pub fn select_pipeline(caps: &Capabilities, info: &MediaInfo, plan: &TranscodePlan) -> Box<dyn HwPipeline> {
    let software = Box::new(Software::from_caps(caps));
    let VideoPlan::Encode { tonemap, .. } = plan.video else { return software };
    let vt_ready = caps.hwaccels.contains(&HwAccel::VideoToolbox) && caps.has_encoder("h264_videotoolbox");
    if !vt_ready {
        return software;
    }
    let vt_tonemap = caps.has_filter("tonemap_videotoolbox");
    // HDR that VideoToolbox can't tone map (stock ffmpeg, or a codec it can't decode in
    // hardware) would come out washed out; prefer a correct software tone map if there is one.
    let vt_can_tonemap = vt_tonemap && VideoToolbox::hw_decodes(info);
    if tonemap && !vt_can_tonemap && caps.software_tonemap().is_some() {
        return software;
    }
    Box::new(VideoToolbox { tonemap: vt_tonemap, hevc: caps.has_encoder("hevc_videotoolbox") })
}

/// Fit the plan to what the chosen pipeline can do: fall back to H.264 (re-deriving the
/// bitrate within the same budget) when the pipeline can't encode HEVC.
pub fn adapt_plan(plan: &mut TranscodePlan, pipeline: &dyn HwPipeline) {
    if let VideoPlan::Encode { target_height, codec, bitrate_kbps, max_kbps, .. } = &mut plan.video
        && !pipeline.supports(*codec)
    {
        *codec = VideoCodec::H264;
        *bitrate_kbps =
            video_bitrate_kbps(*target_height, VideoCodec::H264).min(max_kbps.unwrap_or(u32::MAX));
    }
}

/// Largest even-sized frame that fits a 16:9 box `target_height` tall, keeping the aspect
/// ratio (a 3840x1600 scope film at 1080 becomes 1920x800, not a stretched 1920x1080).
pub fn fit_within(width: u32, height: u32, target_height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let max_w = f64::from(target_height) * 16.0 / 9.0;
    let scale = (max_w / f64::from(width)).min(f64::from(target_height) / f64::from(height)).min(1.0);
    if scale >= 1.0 {
        return (width, height);
    }
    let even = |x: f64| ((x / 2.0).round() as u32 * 2).max(2);
    (even(f64::from(width) * scale), even(f64::from(height) * scale))
}

pub fn build_hls_args(
    input: &Path,
    out_dir: &Path,
    info: &MediaInfo,
    plan: &TranscodePlan,
    opts: &HlsOptions,
    pipeline: &dyn HwPipeline,
) -> Vec<String> {
    let mut a = args(&["-hide_banner", "-nostdin", "-y", "-v", "warning"]);
    a.extend(pipeline.decode_args(info));
    if opts.start_secs > 0.0 {
        // Copied video can only start on a keyframe; without this, audio would still be cut at
        // the exact time and play ahead of the picture. (Callers also move `start_secs` onto
        // the keyframe, so both start together and the player's clock is right.)
        if matches!(plan.video, VideoPlan::Copy) {
            a.push("-noaccurate_seek".into());
        }
        a.extend(args(&["-ss", &format!("{:.3}", opts.start_secs)]));
    }
    a.extend(args(&["-i", &input.to_string_lossy()]));

    if let (Some(v), false) = (&info.video, matches!(plan.video, VideoPlan::None)) {
        a.extend(args(&["-map", &format!("0:{}", v.index)]));
    }
    match plan.audio {
        AudioPlan::Copy { index } | AudioPlan::Aac { index, .. } => {
            a.extend(args(&["-map", &format!("0:{index}")]));
        }
        AudioPlan::None => {}
    }
    a.extend(args(&["-sn", "-dn"]));

    match plan.video {
        VideoPlan::None => a.push("-vn".into()),
        VideoPlan::Copy => {
            a.extend(args(&["-c:v", "copy"]));
            // Copied HEVC needs the hvc1 tag in MP4 for Apple and many TVs.
            if info.video.as_ref().is_some_and(|v| v.codec == "hevc") {
                a.extend(args(&["-tag:v", "hvc1"]));
            }
        }
        VideoPlan::Encode { target_height, tonemap, codec, bitrate_kbps, .. } => {
            if let Some(vf) = pipeline.filter_chain(info, target_height, tonemap) {
                a.extend(args(&["-vf", &vf]));
            }
            a.extend(pipeline.encode_args(codec, bitrate_kbps));
            a.extend(colour_tags(info, tonemap, codec));
            // Keyframe at every segment boundary so segments are independently decodable.
            a.extend(args(&["-force_key_frames", &format!("expr:gte(t,n_forced*{})", opts.segment_secs)]));
        }
    }

    match plan.audio {
        AudioPlan::None => a.push("-an".into()),
        AudioPlan::Copy { .. } => a.extend(args(&["-c:a", "copy"])),
        AudioPlan::Aac { channels, bitrate_kbps, .. } => a.extend(args(&[
            "-c:a",
            "aac",
            "-ac",
            &channels.to_string(),
            "-b:a",
            &format!("{bitrate_kbps}k"),
        ])),
    }

    a.extend(args(&[
        "-f",
        "hls",
        "-hls_time",
        &opts.segment_secs.to_string(),
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        // Fragmented MP4: required for HEVC in HLS, and MSE players use it without remuxing.
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        INIT_SEGMENT,
        "-start_number",
        "0",
        "-hls_segment_filename",
        &out_dir.join("seg_%05d.m4s").to_string_lossy(),
        &out_dir.join(PLAYLIST).to_string_lossy(),
    ]));
    a
}

/// The encoded picture's colours, written into the stream's headers (the H.264/HEVC VUI) by a
/// bitstream filter. Hardware encoders (`VideoToolbox` at least) leave the VUI out, and
/// Android's decoders then draw nothing at all (sound, no picture). A filter after the encoder,
/// not `-color_primaries` & co.: those make ffmpeg convert the frames, which it can't do to
/// hardware frames (the encoder never opens). Encodes are SDR: HD sources and anything tone
/// mapped (the tone mappers output bt709) are BT.709 (code 1); SD sources keep BT.601 (6), as
/// scaling doesn't convert the colour matrix. Limited range, as every encode is.
fn colour_tags(info: &MediaInfo, tonemap: bool, codec: VideoCodec) -> Vec<String> {
    let hd = tonemap || info.video.as_ref().is_some_and(|v| v.height >= 720 || v.width >= 1280);
    let code = if hd { 1 } else { 6 };
    let filter = match codec {
        VideoCodec::H264 => "h264_metadata",
        VideoCodec::Hevc => "hevc_metadata",
    };
    vec![
        "-bsf:v".into(),
        format!(
            "{filter}=colour_primaries={code}:transfer_characteristics={code}:matrix_coefficients={code}:video_full_range_flag=0"
        ),
    ]
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(std::string::ToString::to_string).collect()
}

/// A running ffmpeg HLS job. Dropping it (a request abandoned mid-start, say) kills the process
/// and deletes its segment folder in the background; [`TranscodeSession::stop`] does both now.
#[derive(Debug)]
pub struct TranscodeSession {
    pub dir: PathBuf,
    pub start_secs: f64,
    child: Child,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    /// The folder is already deleted (by `stop`).
    removed: bool,
}

impl Drop for TranscodeSession {
    fn drop(&mut self) {
        if self.removed {
            return;
        }
        // `kill_on_drop` ends ffmpeg; the folder goes off the runtime (it can be large).
        let dir = std::mem::take(&mut self.dir);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(dir);
            });
        }
    }
}

impl TranscodeSession {
    pub async fn spawn(
        paths: &FfmpegPaths,
        args: Vec<String>,
        dir: PathBuf,
        start_secs: f64,
    ) -> Result<Self> {
        tokio::fs::create_dir_all(&dir).await?;
        tracing::debug!(cmd = %format!("{} {}", paths.ffmpeg.display(), args.join(" ")), "starting transcode");
        let spawned = Command::new(&paths.ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(source) => {
                let _ = tokio::fs::remove_dir_all(&dir).await;
                return Err(Error::Spawn { bin: paths.ffmpeg.display().to_string(), source });
            }
        };

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(32)));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "ffmpeg", "{line}");
                    let mut t = tail.lock().unwrap();
                    if t.len() == 32 {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            });
        }
        Ok(Self { dir, start_secs, child, stderr_tail, removed: false })
    }

    /// Freeze ffmpeg (`SIGSTOP`) to stop it running far ahead of the viewer. It keeps its
    /// state and resumes exactly where it was. No-op where signals aren't available.
    pub fn pause(&self) {
        self.signal(true);
    }

    /// Continue a paused ffmpeg (`SIGCONT`).
    pub fn resume(&self) {
        self.signal(false);
    }

    #[cfg(unix)]
    fn signal(&self, stop: bool) {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        let Some(pid) = self.child.id().and_then(|p| i32::try_from(p).ok()) else { return };
        let sig = if stop { Signal::SIGSTOP } else { Signal::SIGCONT };
        if let Err(e) = kill(Pid::from_raw(pid), sig) {
            tracing::debug!(pid, ?sig, error = %e, "signal to ffmpeg failed");
        }
    }

    #[cfg(not(unix))]
    fn signal(&self, _stop: bool) {}

    /// ffmpeg has exited (the whole file is transcoded, or it failed).
    pub fn finished(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|s| s.is_some())
    }

    /// Segments listed in the playlist so far.
    pub async fn produced_segments(&self) -> u32 {
        tokio::fs::read_to_string(self.playlist())
            .await
            .map_or(0, |t| u32::try_from(t.matches("#EXTINF").count()).unwrap_or(u32::MAX))
    }

    /// Path of media segment `index` (as named by [`build_hls_args`]).
    pub fn segment_path(&self, index: u32) -> PathBuf {
        self.dir.join(format!("seg_{index:05}.m4s"))
    }

    pub fn playlist(&self) -> PathBuf {
        self.dir.join(PLAYLIST)
    }

    /// Wait until the playlist lists at least one segment, or ffmpeg fails.
    pub async fn wait_ready(&mut self, timeout: Duration) -> Result<()> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Ok(text) = tokio::fs::read_to_string(self.playlist()).await
                && text.contains("#EXTINF")
            {
                return Ok(());
            }
            if let Some(status) = self.child.try_wait()? {
                // Finished already (very short input) is fine if the playlist exists.
                if status.success() && self.playlist().exists() {
                    return Ok(());
                }
                return Err(Error::Failed { bin: "ffmpeg".into(), status, stderr: self.stderr_tail() });
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::Timeout("first HLS segment"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Kill ffmpeg and delete the segment directory.
    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = tokio::fs::remove_dir_all(&self.dir).await;
        self.removed = true;
    }
}

/// The CPU tone-mapping filter (HDR -> SDR bt709, 8-bit yuv420p) for a software method, or
/// `None` for hardware methods. Shared by transcodes and scrub thumbnails.
pub fn software_tonemap_filter(method: TonemapMethod) -> Option<&'static str> {
    match method {
        // Same shape as Jellyfin's software tone-mapping chain.
        TonemapMethod::Tonemapx => {
            Some("tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p")
        }
        TonemapMethod::Zscale => Some(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,\
             tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing_ffmpeg() -> FfmpegPaths {
        FfmpegPaths {
            ffmpeg: "/nonexistent/ffmpeg".into(),
            ffprobe: "/nonexistent/ffprobe".into(),
            flavor: crate::ffmpeg::Flavor::Stock,
            version: String::new(),
        }
    }

    #[tokio::test]
    async fn a_stream_that_fails_to_start_leaves_no_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("session");
        assert!(TranscodeSession::spawn(&missing_ffmpeg(), vec![], dir.clone(), 0.0).await.is_err());
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn a_dropped_stream_deletes_its_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("session");
        let paths = FfmpegPaths { ffmpeg: "/bin/sleep".into(), ..missing_ffmpeg() };
        let session = TranscodeSession::spawn(&paths, vec!["5".into()], dir.clone(), 0.0).await.unwrap();
        std::fs::write(dir.join("seg_00000.m4s"), b"x").unwrap();
        drop(session);
        for _ in 0..50 {
            if !dir.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("segment folder left behind");
    }
    use crate::probe;

    fn hdr_movie() -> MediaInfo {
        probe::parse(
            r#"{"streams":[
            {"index":0,"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,
             "pix_fmt":"yuv420p10le","color_transfer":"smpte2084"},
            {"index":1,"codec_type":"audio","codec_name":"eac3","channels":6}],
            "format":{"format_name":"matroska,webm","duration":"100.0"}}"#,
        )
        .unwrap()
    }

    fn encode(codec: VideoCodec, bitrate_kbps: u32) -> TranscodePlan {
        TranscodePlan {
            video: VideoPlan::Encode {
                target_height: 1080,
                tonemap: true,
                codec,
                bitrate_kbps,
                max_kbps: None,
            },
            audio: AudioPlan::Aac { index: 1, channels: 2, bitrate_kbps: 192 },
        }
    }

    #[test]
    fn ladder() {
        assert_eq!(video_bitrate_kbps(2160, VideoCodec::H264), 20_000);
        assert_eq!(video_bitrate_kbps(1080, VideoCodec::Hevc), 4_800);
        assert_eq!(video_bitrate_kbps(800, VideoCodec::H264), 4_000, "between rungs uses the lower rung");
        assert_eq!(height_for_budget(8_000, VideoCodec::H264, 2160), 1080);
        assert_eq!(height_for_budget(8_000, VideoCodec::Hevc, 2160), 1440);
        assert_eq!(height_for_budget(100_000, VideoCodec::H264, 1080), 1080, "never above max_height");
        assert_eq!(height_for_budget(100, VideoCodec::H264, 2160), 360, "floor");
    }

    #[test]
    fn software_hdr_args_snapshot() {
        let opts = HlsOptions { start_secs: 30.0, ..Default::default() };
        let sw = Software { tonemap: Some(TonemapMethod::Tonemapx), hevc: false };
        let a = build_hls_args(
            Path::new("/m/in.mkv"),
            Path::new("/t/s1"),
            &hdr_movie(),
            &encode(VideoCodec::H264, 8_000),
            &opts,
            &sw,
        );
        assert_eq!(
            a.join(" "),
            "-hide_banner -nostdin -y -v warning -ss 30.000 -i /m/in.mkv -map 0:0 -map 0:1 -sn -dn \
             -vf scale=1920:1080,tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p \
             -c:v libx264 -preset veryfast -crf 23 -profile:v high -maxrate 8000k -bufsize 16000k -sc_threshold 0 \
             -bsf:v h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0 \
             -force_key_frames expr:gte(t,n_forced*3) -c:a aac -ac 2 -b:a 192k \
             -f hls -hls_time 3 -hls_playlist_type event -hls_flags independent_segments+temp_file \
             -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -start_number 0 \
             -hls_segment_filename /t/s1/seg_%05d.m4s /t/s1/index.m3u8"
        );
    }

    #[test]
    fn zscale_fallback_when_no_tonemapx() {
        let sw = Software { tonemap: Some(TonemapMethod::Zscale), hevc: false };
        let vf = sw.filter_chain(&hdr_movie(), 2160, true).unwrap();
        assert!(vf.starts_with("zscale=t=linear") && !vf.contains("scale=1"));
    }

    #[test]
    fn remux_copies_streams_and_tags_hevc() {
        let plan = TranscodePlan { video: VideoPlan::Copy, audio: AudioPlan::Copy { index: 1 } };
        let sw = Software { tonemap: None, hevc: false };
        let a = build_hls_args(
            Path::new("in.mkv"),
            Path::new("out"),
            &hdr_movie(),
            &plan,
            &HlsOptions::default(),
            &sw,
        )
        .join(" ");
        assert!(a.contains("-c:v copy -tag:v hvc1") && a.contains("-c:a copy") && !a.contains("-ss"), "{a}");
    }

    #[test]
    fn copied_video_seeks_without_accurate_seek() {
        let plan = TranscodePlan { video: VideoPlan::Copy, audio: AudioPlan::Copy { index: 1 } };
        let sw = Software { tonemap: None, hevc: false };
        let opts = HlsOptions { start_secs: 104.004, ..Default::default() };
        let a =
            build_hls_args(Path::new("in.mkv"), Path::new("out"), &hdr_movie(), &plan, &opts, &sw).join(" ");
        assert!(a.contains("-noaccurate_seek -ss 104.004 -i in.mkv"), "{a}");
    }

    #[test]
    fn fit_within_keeps_aspect_ratio() {
        assert_eq!(fit_within(3840, 2160, 1080), (1920, 1080));
        assert_eq!(fit_within(3840, 2076, 1080), (1920, 1038));
        assert_eq!(fit_within(3840, 1600, 720), (1280, 534));
        assert_eq!(fit_within(1440, 1080, 720), (960, 720), "4:3 is height-bound");
        assert_eq!(fit_within(1280, 720, 1080), (1280, 720), "never upscale");
    }

    #[test]
    fn videotoolbox_hevc_args_snapshot() {
        let vt = VideoToolbox { tonemap: true, hevc: true };
        let a = build_hls_args(
            Path::new("/m/in.mkv"),
            Path::new("/t/s"),
            &hdr_movie(),
            &encode(VideoCodec::Hevc, 4_800),
            &HlsOptions::default(),
            &vt,
        )
        .join(" ");
        assert!(
            a.starts_with(
                "-hide_banner -nostdin -y -v warning -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i /m/in.mkv"
            ),
            "{a}"
        );
        assert!(a.contains("-vf scale_vt=w=1920:h=1080,tonemap_videotoolbox=format=nv12:"), "{a}");
        assert!(
            a.contains(
                "-c:v hevc_videotoolbox -profile:v main -tag:v hvc1 -b:v 4800k -maxrate 4800k -bufsize 9600k"
            ),
            "{a}"
        );
        assert!(a.contains("-force_key_frames expr:gte(t,n_forced*3)"), "{a}");
        // Without colour tags VideoToolbox writes no VUI, and Android draws nothing. Never as
        // output options: ffmpeg would convert the hardware frames, and the encoder never opens.
        assert!(a.contains("-bsf:v hevc_metadata=colour_primaries=1:"), "{a}");
        assert!(!a.contains("-colorspace") && !a.contains("-color_primaries"), "{a}");
    }

    #[test]
    fn sd_encodes_are_tagged_bt601() {
        let info = probe::parse(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"mpeg2video",
            "width":720,"height":480,"pix_fmt":"yuv420p"}],"format":{"format_name":"mpeg"}}"#,
        )
        .unwrap();
        let tags = |info: &MediaInfo, tonemap| colour_tags(info, tonemap, VideoCodec::H264).join(" ");
        assert!(tags(&info, false).contains("h264_metadata=colour_primaries=6:transfer_characteristics=6:"));
        assert!(tags(&info, true).contains("colour_primaries=1:"), "tone mapped output is bt709");
        assert!(tags(&hdr_movie(), true).contains("colour_primaries=1:"));
    }

    #[test]
    fn videotoolbox_software_decodes_unsupported_codecs() {
        let info = probe::parse(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"mpeg4",
            "width":720,"height":480,"pix_fmt":"yuv420p"}],"format":{"format_name":"avi"}}"#,
        )
        .unwrap();
        let vt = VideoToolbox { tonemap: false, hevc: true };
        assert!(vt.decode_args(&info).is_empty());
        assert_eq!(vt.filter_chain(&info, 360, false).as_deref(), Some("scale=540:360,format=nv12"));
    }

    #[test]
    fn plan_falls_back_to_h264_within_the_same_budget() {
        let sw = Software { tonemap: None, hevc: false };
        let mut plan = encode(VideoCodec::Hevc, 4_800);
        if let VideoPlan::Encode { max_kbps, .. } = &mut plan.video {
            *max_kbps = Some(5_000);
        }
        adapt_plan(&mut plan, &sw);
        assert!(matches!(plan.video, VideoPlan::Encode { codec: VideoCodec::H264, bitrate_kbps: 5_000, .. }));
        let mut unlimited = encode(VideoCodec::Hevc, 4_800);
        adapt_plan(&mut unlimited, &sw);
        assert!(matches!(
            unlimited.video,
            VideoPlan::Encode { codec: VideoCodec::H264, bitrate_kbps: 8_000, .. }
        ));
    }

    fn caps(hw: bool, filters: &[&str], encoders: &[&str]) -> Capabilities {
        let hwaccels: std::collections::BTreeSet<HwAccel> =
            if hw { [HwAccel::VideoToolbox].into() } else { std::collections::BTreeSet::default() };
        let filters: std::collections::BTreeSet<String> = filters.iter().map(|s| (*s).to_string()).collect();
        Capabilities {
            flavor: crate::ffmpeg::Flavor::Jellyfin,
            version: String::new(),
            tonemap: crate::caps::select_tonemap(&hwaccels, &filters),
            hwaccels,
            encoders: encoders.iter().map(|s| (*s).to_string()).collect(),
            filters,
        }
    }

    #[test]
    fn pipeline_selection() {
        let enc = |tonemap| TranscodePlan {
            video: VideoPlan::Encode {
                target_height: 1080,
                tonemap,
                codec: VideoCodec::H264,
                bitrate_kbps: 8000,
                max_kbps: None,
            },
            audio: AudioPlan::None,
        };
        let jellyfin_mac =
            caps(true, &["tonemap_videotoolbox", "tonemapx"], &["h264_videotoolbox", "libx264"]);
        let stock_mac = caps(true, &[], &["h264_videotoolbox", "libx264"]);
        let stock_mac_zscale = caps(true, &["zscale", "tonemap"], &["h264_videotoolbox", "libx264"]);
        let linux_cpu = caps(false, &["tonemapx"], &["libx264"]);
        let m = hdr_movie();
        assert_eq!(select_pipeline(&jellyfin_mac, &m, &enc(true)).name(), "videotoolbox");
        assert_eq!(select_pipeline(&stock_mac, &m, &enc(false)).name(), "videotoolbox");
        // HDR on stock ffmpeg: correct colors in software beat speed in hardware...
        assert_eq!(select_pipeline(&stock_mac_zscale, &m, &enc(true)).name(), "software");
        // ...but with no software tone mapper either, hardware is at least fast.
        assert_eq!(select_pipeline(&stock_mac, &m, &enc(true)).name(), "videotoolbox");
        assert_eq!(select_pipeline(&linux_cpu, &m, &enc(true)).name(), "software");
        let copy = TranscodePlan { video: VideoPlan::Copy, audio: AudioPlan::None };
        assert_eq!(select_pipeline(&jellyfin_mac, &m, &copy).name(), "software", "remux needs no encoder");
    }
}
