//! Capability probing: what can this ffmpeg build do on this machine?
//!
//! A filter or hwaccel being *listed* only means it was compiled in. For hardware we also
//! try to open the device, because drivers/permissions are the usual failure point.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::Result;
use crate::ffmpeg::{self, FfmpegPaths, Flavor};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HwAccel {
    VideoToolbox,
    Vaapi,
    Qsv,
    Cuda,
    OpenCl,
}

impl HwAccel {
    pub const ALL: [HwAccel; 5] =
        [HwAccel::VideoToolbox, HwAccel::Vaapi, HwAccel::Qsv, HwAccel::Cuda, HwAccel::OpenCl];

    /// Name as printed by `ffmpeg -hwaccels`.
    fn listed_name(self) -> &'static str {
        match self {
            HwAccel::VideoToolbox => "videotoolbox",
            HwAccel::Vaapi => "vaapi",
            HwAccel::Qsv => "qsv",
            HwAccel::Cuda => "cuda",
            HwAccel::OpenCl => "opencl",
        }
    }

    /// `-init_hw_device` arguments used to verify the device really opens.
    fn init_args(self) -> &'static [&'static str] {
        match self {
            HwAccel::VideoToolbox => &["-init_hw_device", "videotoolbox=vt"],
            HwAccel::Vaapi => &["-init_hw_device", "vaapi=va:/dev/dri/renderD128"],
            HwAccel::Qsv => {
                &["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-init_hw_device", "qsv=qs@va"]
            }
            HwAccel::Cuda => &["-init_hw_device", "cuda=cu:0"],
            HwAccel::OpenCl => &["-init_hw_device", "opencl=ocl"],
        }
    }
}

/// HDR -> SDR tone-mapping strategies, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TonemapMethod {
    /// `tonemap_videotoolbox` (jellyfin-ffmpeg, macOS).
    VideoToolbox,
    /// `tonemap_cuda` (jellyfin-ffmpeg, NVIDIA).
    Cuda,
    /// `tonemap_opencl` (Intel/AMD/NVIDIA with `OpenCL` runtime).
    OpenCl,
    /// `tonemap_vaapi` (Intel VPP).
    Vaapi,
    /// `tonemapx`: jellyfin-ffmpeg's SIMD software tone mapper. Works anywhere.
    Tonemapx,
    /// `zscale` + `tonemap`: stock ffmpeg with libzimg. Slow but correct.
    Zscale,
}

impl TonemapMethod {
    pub fn is_software(self) -> bool {
        matches!(self, TonemapMethod::Tonemapx | TonemapMethod::Zscale)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub flavor: Flavor,
    pub version: String,
    /// Hardware accelerators that are compiled in *and* whose device opened.
    pub hwaccels: BTreeSet<HwAccel>,
    pub encoders: BTreeSet<String>,
    pub filters: BTreeSet<String>,
    /// Usable tone-mapping methods, best first.
    pub tonemap: Vec<TonemapMethod>,
}

impl Capabilities {
    pub fn has_encoder(&self, name: &str) -> bool {
        self.encoders.contains(name)
    }

    pub fn has_filter(&self, name: &str) -> bool {
        self.filters.contains(name)
    }

    /// Best tone-mapping method that runs on the CPU (what the software pipeline uses).
    pub fn software_tonemap(&self) -> Option<TonemapMethod> {
        self.tonemap.iter().copied().find(|m| m.is_software())
    }
}

pub async fn probe(paths: &FfmpegPaths) -> Result<Capabilities> {
    let bin = &paths.ffmpeg;
    let (hw, enc, filt) = tokio::try_join!(
        ffmpeg::run(bin, &["-hide_banner", "-hwaccels"]),
        ffmpeg::run(bin, &["-hide_banner", "-encoders"]),
        ffmpeg::run(bin, &["-hide_banner", "-filters"]),
    )?;

    let listed = parse_hwaccels(&hw);
    let encoders = parse_component_list(&enc);
    let filters = parse_component_list(&filt);

    let mut hwaccels = BTreeSet::new();
    for accel in HwAccel::ALL {
        // OpenCL isn't printed by `-hwaccels` (it's not a decoder); treat the filter as the signal.
        let compiled = if accel == HwAccel::OpenCl {
            filters.contains("tonemap_opencl") || filters.contains("scale_opencl")
        } else {
            listed.contains(accel.listed_name())
        };
        if compiled && device_opens(paths, accel).await {
            hwaccels.insert(accel);
        }
    }

    let tonemap = select_tonemap(&hwaccels, &filters);
    let caps = Capabilities {
        flavor: paths.flavor,
        version: paths.version.clone(),
        hwaccels,
        encoders,
        filters,
        tonemap,
    };
    tracing::info!(hwaccels = ?caps.hwaccels, tonemap = ?caps.tonemap, "ffmpeg capabilities");
    Ok(caps)
}

pub fn select_tonemap(hw: &BTreeSet<HwAccel>, filters: &BTreeSet<String>) -> Vec<TonemapMethod> {
    let f = |name: &str| filters.contains(name);
    let mut out = Vec::new();
    if hw.contains(&HwAccel::VideoToolbox) && f("tonemap_videotoolbox") {
        out.push(TonemapMethod::VideoToolbox);
    }
    if hw.contains(&HwAccel::Cuda) && f("tonemap_cuda") {
        out.push(TonemapMethod::Cuda);
    }
    if hw.contains(&HwAccel::OpenCl) && f("tonemap_opencl") {
        out.push(TonemapMethod::OpenCl);
    }
    if hw.contains(&HwAccel::Vaapi) && f("tonemap_vaapi") {
        out.push(TonemapMethod::Vaapi);
    }
    if f("tonemapx") {
        out.push(TonemapMethod::Tonemapx);
    }
    if f("zscale") && f("tonemap") {
        out.push(TonemapMethod::Zscale);
    }
    out
}

async fn device_opens(paths: &FfmpegPaths, accel: HwAccel) -> bool {
    let mut cmd = Command::new(&paths.ffmpeg);
    cmd.args(["-hide_banner", "-v", "error"])
        .args(accel.init_args())
        .args(["-f", "lavfi", "-i", "nullsrc=s=64x64", "-frames:v", "1", "-f", "null", "-"])
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            tracing::debug!(?accel, stderr = %String::from_utf8_lossy(&out.stderr).trim(), "hw device unavailable");
            false
        }
        _ => false,
    }
}

fn parse_hwaccels(out: &str) -> BTreeSet<String> {
    out.lines()
        .skip_while(|l| !l.starts_with("Hardware acceleration methods"))
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// Parses `ffmpeg -encoders` / `-filters` tables: ` <flags> <name> <description...>`.
/// Legend lines (`V..... = Video`) and separators are skipped.
fn parse_component_list(out: &str) -> BTreeSet<String> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let flags = it.next()?;
            let name = it.next()?;
            let is_flags = flags.chars().all(|c| c.is_ascii_uppercase() || c == '.' || c == '|');
            (is_flags && name != "=" && it.next().is_some()).then(|| name.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENCODERS: &str = "Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
";

    const FILTERS: &str = "Filters:
  T.. = Timeline support
  A = Audio input/output
  | = Source or sink filter
 TS aap               AA->A      Apply Affine Projection algorithm.
 .S tonemap           V->V       Conversion to/from different dynamic ranges.
 .. tonemapx          V->V       HDR to SDR tonemapping (jellyfin)
 .. tonemap_videotoolbox V->V    Tone mapping on VideoToolbox frames
";

    #[test]
    fn parses_encoders() {
        let e = parse_component_list(ENCODERS);
        assert_eq!(e.into_iter().collect::<Vec<_>>(), ["aac", "h264_videotoolbox", "libx264"]);
    }

    #[test]
    fn parses_filters_and_skips_legend() {
        let f = parse_component_list(FILTERS);
        assert!(f.contains("tonemapx") && f.contains("tonemap") && f.contains("aap"));
        assert!(!f.contains("="));
        assert_eq!(f.len(), 4);
    }

    #[test]
    fn parses_hwaccels() {
        let h = parse_hwaccels("Hardware acceleration methods:\nvideotoolbox\n\n");
        assert!(h.contains("videotoolbox") && h.len() == 1);
    }

    #[test]
    fn tonemap_prefers_hardware_then_tonemapx() {
        let filters = parse_component_list(FILTERS);
        let hw = BTreeSet::from([HwAccel::VideoToolbox]);
        assert_eq!(select_tonemap(&hw, &filters), [TonemapMethod::VideoToolbox, TonemapMethod::Tonemapx]);
        // tonemap without zscale is not usable on its own.
        assert_eq!(select_tonemap(&BTreeSet::new(), &filters), [TonemapMethod::Tonemapx]);
    }
}
