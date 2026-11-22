//! `panda bench`: how many streams this machine can serve at once, and what its ffmpeg can do.
//!
//! Runs the server's own ffmpeg commands (the pipeline `select_pipeline` picks, the HLS
//! arguments `build_hls_args` builds) on files from the library: 1, 2, 3... streams at once,
//! each from its own place in its file, each making `--seconds` of video. A count passes when
//! every stream runs at least [`MIN_SPEED`]x real time (playback needs 1x; the rest is
//! headroom for network shares and the rest of the machine). Read-only: nothing in the
//! library or the database changes; output goes to a temporary folder in the cache.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;
use panda_db::{Db, Item, ItemFilter};
use panda_media::caps::{self, Capabilities};
use panda_media::ffmpeg::{self, FfmpegPaths};
use panda_media::probe::MediaInfo;
use panda_media::transcode::{
    AudioPlan, HlsOptions, TranscodePlan, VideoCodec, VideoPlan, build_hls_args, select_pipeline,
    video_bitrate_kbps,
};
use serde::{Deserialize, Serialize};

use crate::Config;

/// Real-time multiple each stream must keep (1x is the bare minimum for playback).
pub const MIN_SPEED: f64 = 1.1;

/// What `panda bench` was asked.
#[derive(Debug, Clone)]
pub struct Options {
    /// Most streams tried per kind.
    pub max: usize,
    /// Seconds of video each stream makes.
    pub seconds: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self { max: 10, seconds: 20 }
    }
}

/// `panda bench [--max N] [--seconds S]`.
pub fn parse_args(args: &[String]) -> anyhow::Result<Options> {
    let mut o = Options::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| -> anyhow::Result<u32> {
            it.next().and_then(|v| v.parse().ok()).with_context(|| format!("{name} needs a number"))
        };
        match a.as_str() {
            "--max" => o.max = value("--max")?.clamp(1, 64) as usize,
            "--seconds" => o.seconds = value("--seconds")?.clamp(5, 120),
            other => anyhow::bail!("unknown option {other} (try: panda bench --max 10 --seconds 20)"),
        }
    }
    Ok(o)
}

/// One kind of stream to measure.
struct Scenario {
    name: &'static str,
    item: Item,
    media: MediaInfo,
    plan: TranscodePlan,
}

/// What a test found: the machine's ffmpeg, and per kind of stream how many kept up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    /// Unix seconds when it finished.
    pub ran_at: i64,
    pub seconds: u32,
    pub ffmpeg: FfmpegSummary,
    pub kinds: Vec<KindResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FfmpegSummary {
    pub version: String,
    pub hardware: Vec<String>,
    pub encoders: Vec<String>,
    pub tonemap: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KindResult {
    pub name: String,
    /// `copy`, or the pipeline that encodes (`videotoolbox`, `software`).
    pub how: String,
    pub file: String,
    /// Slowest stream's speed at 1, 2, 3... at once (`None`: a stream failed).
    pub rounds: Vec<Option<f64>>,
    /// Most streams at once that all kept [`MIN_SPEED`].
    pub best: usize,
    /// Most tried: `best == max` means it may do more.
    pub max: usize,
    /// A re-encode on the hardware encoder (what the hardware limit is about).
    pub hardware_encode: bool,
}

impl Report {
    /// A hardware re-encode limit from the results: one below the fewest that kept up among the
    /// everyday re-encodes (to 1080p; 4K to 4K is rare), for headroom. `None` without any.
    #[must_use]
    pub fn suggested_hardware_limit(&self) -> Option<usize> {
        self.kinds
            .iter()
            .filter(|k| k.hardware_encode && !k.name.ends_with("to 4K"))
            .map(|k| k.best)
            .min()
            .map(|b| b.saturating_sub(1).max(1))
    }
}

/// Run the test with this machine's ffmpeg on `db`'s library, telling `progress` each line as
/// it goes. `work` is a scratch folder (removed after).
pub async fn measure(
    paths: &FfmpegPaths,
    caps: &Capabilities,
    db: &Db,
    opts: &Options,
    work: &Path,
    mut progress: impl FnMut(String),
) -> anyhow::Result<Report> {
    let ffmpeg = summary(caps);
    let scenarios = scenarios(db).await?;
    if scenarios.is_empty() {
        progress("No probed video files in the library yet: scan a library first.".into());
    }
    let mut kinds = Vec::new();
    for s in &scenarios {
        let pipeline = select_pipeline(caps, &s.media, &s.plan);
        // A repackage copies the video: no pipeline encodes anything.
        let copy = matches!(s.plan.video, VideoPlan::Copy);
        let how = if copy { "copy" } else { pipeline.name() }.to_string();
        progress(format!("{} ({how}, {})", s.name, file_name(&s.item.path)));
        let (mut best, mut rounds) = (0, Vec::new());
        for n in 1..=opts.max {
            let speeds = round(paths, caps, s, n, opts.seconds, work).await;
            let slowest = speeds.iter().copied().fold(f64::INFINITY, f64::min);
            let ok = speeds.len() == n && slowest >= MIN_SPEED;
            rounds.push(slowest.is_finite().then_some(slowest));
            progress(format!(
                "  {n:>2} at once: slowest {}{}",
                if slowest.is_finite() { format!("{slowest:.1}x") } else { "failed".into() },
                if ok { "" } else { "  <- too slow" }
            ));
            if !ok {
                break;
            }
            best = n;
        }
        kinds.push(KindResult {
            name: s.name.to_string(),
            hardware_encode: !copy && how != "software",
            how,
            file: file_name(&s.item.path),
            rounds,
            best,
            max: opts.max,
        });
    }
    let _ = tokio::fs::remove_dir_all(work).await;
    Ok(Report { ran_at: crate::services::settings::now(), seconds: opts.seconds, ffmpeg, kinds })
}

/// `panda bench`: the test, printed.
pub async fn run(opts: Options) -> anyhow::Result<()> {
    let config = Config::load().context("loading config")?;
    let db = Db::open(&config.database_url()).await.context("opening database")?;
    let paths = ffmpeg::discover(config.ffmpeg.ffmpeg_path.as_deref(), config.ffmpeg.ffprobe_path.as_deref())
        .await
        .context("locating ffmpeg")?;
    let caps = caps::probe(&paths).await.context("probing ffmpeg")?;
    print_capabilities(&paths, &caps);
    println!(
        "\nStreams at once, each making {}s of video; passing means every stream ran at {MIN_SPEED}x real time or better.\n",
        opts.seconds
    );
    let work = config.cache_dir().join("bench");
    let report = measure(&paths, &caps, &db, &opts, &work, |line| println!("{line}")).await?;
    // Kept like a run from the admin UI, which shows the latest either way.
    if let Ok(json) = serde_json::to_string(&Some(&report)) {
        db.set_setting(crate::services::bench::REPORT, &json, false, crate::services::settings::now())
            .await?;
    }
    println!("\nSummary");
    for k in &report.kinds {
        let shown =
            if k.best == k.max { format!("{}+ (the most tried)", k.best) } else { k.best.to_string() };
        println!("  {:<34} {shown}", k.name);
    }
    if let Some(n) = report.suggested_hardware_limit() {
        println!("\nSuggested hardware re-encode limit: {n} ([transcoding] max_hardware, or the admin UI).");
    }
    Ok(())
}

fn summary(caps: &Capabilities) -> FfmpegSummary {
    FfmpegSummary {
        version: caps.version.split_whitespace().nth(2).unwrap_or(&caps.version).to_string(),
        hardware: caps.hwaccels.iter().map(|h| format!("{h:?}")).collect(),
        encoders: ENCODERS.iter().filter(|e| caps.has_encoder(e)).map(|e| (*e).to_string()).collect(),
        tonemap: caps.tonemap.iter().map(|t| format!("{t:?}")).collect(),
    }
}

/// The encoders worth reporting (hardware ones first).
const ENCODERS: [&str; 12] = [
    "h264_videotoolbox",
    "hevc_videotoolbox",
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "h264_vaapi",
    "hevc_vaapi",
    "libx264",
    "libx265",
    "aac",
    "libwebp",
];

/// The files to measure with, from the library: a 4K HDR movie, a 4K movie, a 1080p one (the
/// longest of each, so streams start far apart).
async fn scenarios(db: &Db) -> anyhow::Result<Vec<Scenario>> {
    let items = db.items(&ItemFilter::default()).await?;
    let pick = |want: &dyn Fn(&Item) -> bool| {
        items
            .iter()
            .filter(|i| want(i) && i.duration_secs.unwrap_or(0.0) > 900.0)
            .max_by(|a, b| a.duration_secs.unwrap_or(0.0).total_cmp(&b.duration_secs.unwrap_or(0.0)))
            .map(|i| i.id)
    };
    let hdr = |i: &Item| i.dynamic_range.as_deref().is_some_and(|r| r != "sdr");
    let tall = |i: &Item| i.height.unwrap_or(0) >= 2000;
    let hd = |i: &Item| (1000..1300).contains(&i.height.unwrap_or(0));
    let uhd_hdr = pick(&|i| tall(i) && hdr(i));
    let uhd = pick(&|i| tall(i) && !hdr(i)).or(uhd_hdr);
    let full_hd = pick(&|i| hd(i) && !hdr(i));

    let mut out = Vec::new();
    let mut add = async |name,
                         id: Option<i64>,
                         video: &(dyn Fn(&MediaInfo) -> VideoPlan + Sync)|
           -> anyhow::Result<()> {
        let Some(id) = id else { return Ok(()) };
        let Some(item) = db.item(id).await? else { return Ok(()) };
        let Some(media) = item.probe_json.as_deref().and_then(|j| serde_json::from_str::<MediaInfo>(j).ok())
        else {
            return Ok(());
        };
        let audio =
            media.audio.iter().find(|a| a.default).or(media.audio.first()).map_or(AudioPlan::None, |a| {
                AudioPlan::Aac { index: a.index, channels: 2, bitrate_kbps: 192 }
            });
        let plan = TranscodePlan { video: video(&media), audio };
        out.push(Scenario { name, item, media, plan });
        Ok(())
    };
    let encode = |height: u32, tonemap: bool| VideoPlan::Encode {
        target_height: height,
        tonemap,
        codec: VideoCodec::H264,
        bitrate_kbps: video_bitrate_kbps(height, VideoCodec::H264),
        max_kbps: None,
    };
    let is_hdr = |m: &MediaInfo| {
        m.video.as_ref().is_some_and(|v| !matches!(v.range, panda_media::probe::DynamicRange::Sdr))
    };
    add("4K, repackaged (no re-encode)", uhd.or(uhd_hdr), &|_| VideoPlan::Copy).await?;
    add("1080p, re-encoded to 1080p", full_hd, &|_| encode(1080, false)).await?;
    add("4K, re-encoded to 1080p", uhd, &|m| encode(1080, is_hdr(m))).await?;
    if uhd_hdr != uhd {
        add("4K HDR, re-encoded to 1080p SDR", uhd_hdr, &|_| encode(1080, true)).await?;
    }
    add("4K, re-encoded to 4K", uhd.or(uhd_hdr), &|m| encode(2160, is_hdr(m))).await?;
    Ok(out)
}

/// `n` streams of `s` at once; the speed of each that finished (video seconds per second).
async fn round(
    paths: &FfmpegPaths,
    caps: &Capabilities,
    s: &Scenario,
    n: usize,
    seconds: u32,
    work: &Path,
) -> Vec<f64> {
    let duration = s.media.duration_secs.unwrap_or(3600.0);
    let jobs = (0..n).map(|k| {
        // Spread over the file: no two streams read the same part (or the same cache).
        let start = 120.0 + (duration - 240.0).max(60.0) * (k as f64 + 0.5) / n as f64;
        let out = work.join(format!("{}-{n}-{k}", s.item.id));
        let pipeline = select_pipeline(caps, &s.media, &s.plan);
        let opts = HlsOptions { start_secs: start, ..Default::default() };
        let mut args =
            build_hls_args(Path::new(&s.item.path), &out, &s.media, &s.plan, &opts, pipeline.as_ref());
        // Only `seconds` of it: `-t` right after the input.
        if let Some(i) = args.iter().position(|a| a == "-i") {
            args.splice(i + 2..i + 2, ["-t".to_string(), seconds.to_string()]);
        }
        let ffmpeg = paths.ffmpeg.clone();
        async move {
            let _ = tokio::fs::remove_dir_all(&out).await;
            tokio::fs::create_dir_all(&out).await.ok()?;
            let started = Instant::now();
            let run = tokio::process::Command::new(&ffmpeg).args(&args).kill_on_drop(true).output();
            let status =
                tokio::time::timeout(Duration::from_secs(u64::from(seconds) * 10), run).await.ok()?.ok()?;
            let _ = tokio::fs::remove_dir_all(&out).await;
            status.status.success().then(|| f64::from(seconds) / started.elapsed().as_secs_f64())
        }
    });
    futures_util::future::join_all(jobs).await.into_iter().flatten().collect()
}

fn print_capabilities(paths: &FfmpegPaths, caps: &Capabilities) {
    let f = summary(caps);
    println!("Panda stream test\n");
    println!("ffmpeg       {} ({:?}) at {}", f.version, caps.flavor, paths.ffmpeg.display());
    println!(
        "Hardware     {}",
        if f.hardware.is_empty() { "none (software only)".into() } else { f.hardware.join(", ") }
    );
    println!("Encoders     {}", f.encoders.join(", "));
    println!(
        "HDR to SDR   {}",
        if f.tonemap.is_empty() {
            "not available (HDR plays washed out on SDR TVs)".into()
        } else {
            f.tonemap.join(", ")
        }
    );
    println!(
        "Formats      any container ffmpeg reads (MKV, MP4, AVI, TS...): played as is when the TV can, else\n\
         \x20            repackaged (video copied) or re-encoded to H.264/HEVC; audio to AAC when needed;\n\
         \x20            text subtitles as WebVTT, PGS as images, never burned in."
    );
}

fn file_name(path: &str) -> String {
    PathBuf::from(path).file_name().map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn options_parse_and_stay_in_range() {
        let o = parse_args(&args(&[])).unwrap();
        assert_eq!((o.max, o.seconds), (10, 20));
        let o = parse_args(&args(&["--max", "4", "--seconds", "30"])).unwrap();
        assert_eq!((o.max, o.seconds), (4, 30));
        let o = parse_args(&args(&["--max", "500", "--seconds", "1"])).unwrap();
        assert_eq!((o.max, o.seconds), (64, 5), "clamped");
        assert!(parse_args(&args(&["--max"])).is_err());
        assert!(parse_args(&args(&["--fast"])).is_err());
    }
}
