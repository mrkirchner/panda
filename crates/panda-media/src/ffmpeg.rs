use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

use crate::{Error, Result};

/// Where jellyfin-ffmpeg is installed: .deb packages and the Docker image (Linux), the
/// portable build (`/opt`), and Jellyfin's macOS app bundle.
const JELLYFIN_FFMPEG_DIRS: &[&str] = &[
    "/usr/lib/jellyfin-ffmpeg",
    "/usr/share/jellyfin-ffmpeg",
    "/opt/jellyfin-ffmpeg",
    "/Applications/Jellyfin.app/Contents/MacOS",
];

/// Per-user install locations (relative to `$HOME`) for the portable build; no root needed.
const JELLYFIN_FFMPEG_HOME_DIRS: &[&str] =
    &["Library/Application Support/jellyfin-ffmpeg", ".local/share/jellyfin-ffmpeg"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Flavor {
    /// jellyfin-ffmpeg: has `tonemapx`, extra hw tone-mapping filters and hwaccel fixes.
    Jellyfin,
    /// Upstream / distro `FFmpeg`.
    Stock,
}

#[derive(Debug, Clone, Serialize)]
pub struct FfmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub flavor: Flavor,
    /// First line of `ffmpeg -version`.
    pub version: String,
}

/// Locate ffmpeg/ffprobe. Order: explicit config, `PANDA_FFMPEG` env var,
/// jellyfin-ffmpeg install dirs, then `$PATH`.
pub async fn discover(ffmpeg: Option<&Path>, ffprobe: Option<&Path>) -> Result<FfmpegPaths> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = ffmpeg {
        candidates.push(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os("PANDA_FFMPEG") {
        candidates.push(PathBuf::from(p));
    }
    candidates.extend(JELLYFIN_FFMPEG_DIRS.iter().map(|d| Path::new(d).join("ffmpeg")));
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        candidates.extend(JELLYFIN_FFMPEG_HOME_DIRS.iter().map(|d| home.join(d).join("ffmpeg")));
    }
    if let Ok(p) = which::which("ffmpeg") {
        candidates.push(p);
    }

    let ffmpeg = candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| Error::NotFound(display_list(&candidates)))?;

    let ffprobe = match ffprobe {
        Some(p) => p.to_path_buf(),
        None => sibling_ffprobe(&ffmpeg)
            .or_else(|| which::which("ffprobe").ok())
            .ok_or_else(|| Error::NotFound("ffprobe next to ffmpeg or on $PATH".into()))?,
    };

    let out = run(&ffmpeg, &["-hide_banner", "-version"]).await?;
    let version = out.lines().next().unwrap_or_default().trim().to_string();
    let flavor = detect_flavor(&version);

    tracing::info!(ffmpeg = %ffmpeg.display(), ?flavor, %version, "found ffmpeg");
    Ok(FfmpegPaths { ffmpeg, ffprobe, flavor, version })
}

/// jellyfin-ffmpeg builds report versions like `ffmpeg version 7.1.1-Jellyfin`.
pub fn detect_flavor(version_line: &str) -> Flavor {
    if version_line.to_ascii_lowercase().contains("jellyfin") { Flavor::Jellyfin } else { Flavor::Stock }
}

fn sibling_ffprobe(ffmpeg: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let p = ffmpeg.parent()?.join(name);
    p.is_file().then_some(p)
}

fn display_list(paths: &[PathBuf]) -> String {
    paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
}

/// Run a binary to completion and return stdout. Non-zero exit is an error.
pub(crate) async fn run(bin: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run_bytes(bin, args).await?).into_owned())
}

/// [`run`], stdout as bytes (binary output).
pub(crate) async fn run_bytes(bin: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new(bin)
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|source| Error::Spawn { bin: bin.display().to_string(), source })?;
    if !out.status.success() {
        return Err(Error::Failed {
            bin: bin.display().to_string(),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_jellyfin_build() {
        assert_eq!(detect_flavor("ffmpeg version 7.1.1-Jellyfin Copyright (c) 2000-2025"), Flavor::Jellyfin);
        assert_eq!(detect_flavor("ffmpeg version 8.0 Copyright (c) 2000-2025"), Flavor::Stock);
    }
}
