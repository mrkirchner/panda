use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::parse::{Parsed, parse_episode, parse_movie};

pub const VIDEO_EXTENSIONS: &[&str] =
    &["mkv", "mp4", "m4v", "mov", "avi", "ts", "m2ts", "webm", "wmv", "mpg", "mpeg"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    Movies,
    Shows,
}

impl LibraryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LibraryKind::Movies => "movies",
            LibraryKind::Shows => "shows",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub size: u64,
    /// Unix seconds.
    pub mtime: i64,
    pub parsed: Parsed,
}

/// What a walk found, and how many folders or files couldn't be read.
#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub files: Vec<ScannedFile>,
    /// Unreadable folders or files (a share that dropped mid-walk, permissions): a walk with
    /// any is incomplete, so nothing may be pruned on its account.
    pub errors: usize,
}

/// Walk `root` synchronously. Run this inside `spawn_blocking`.
pub fn scan(root: &Path, kind: LibraryKind) -> Vec<ScannedFile> {
    scan_checked(root, kind).files
}

/// [`scan`], also counting what couldn't be read.
pub fn scan_checked(root: &Path, kind: LibraryKind) -> ScanOutcome {
    let mut errors = 0usize;
    let files = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()) && !is_extras_dir(e))
        .filter_map(|r| {
            if r.is_err() {
                errors += 1;
            }
            r.ok()
        })
        .filter(|e| e.file_type().is_file() && is_video(e.path()) && !is_sample(e.path()))
        .collect::<Vec<_>>()
        .into_iter()
        .filter_map(|e| {
            let Ok(meta) = e.metadata() else {
                errors += 1;
                return None;
            };
            let parsed = match kind {
                LibraryKind::Movies => parse_movie(e.path()),
                LibraryKind::Shows => parse_episode(e.path())?,
            };
            Some(ScannedFile {
                path: e.into_path(),
                size: meta.len(),
                mtime: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs() as i64),
                parsed,
            })
        })
        .collect();
    ScanOutcome { files, errors }
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

fn is_extras_dir(e: &walkdir::DirEntry) -> bool {
    const EXTRAS: &[&str] =
        &["extras", "featurettes", "behind the scenes", "deleted scenes", "trailers", "samples"];
    e.file_type().is_dir() && EXTRAS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str())
}

fn is_video(p: &Path) -> bool {
    p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.as_str()))
}

fn is_sample(p: &Path) -> bool {
    p.file_stem().is_some_and(|s| {
        let s = s.to_string_lossy().to_lowercase();
        s == "sample" || s.ends_with("-sample") || s.ends_with(".sample")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_movie_tree() {
        let dir = std::env::temp_dir().join(format!("panda-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for f in [
            "Heat (1995)/Heat (1995).mkv",
            "Heat (1995)/Heat (1995).srt",
            "Heat (1995)/Extras/Making Of.mkv",
            "Heat (1995)/sample.mkv",
            ".hidden/x.mkv",
        ] {
            let p = dir.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        }
        let found = scan(&dir, LibraryKind::Movies);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].parsed, Parsed::Movie { title: "Heat".into(), year: Some(1995) });
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_folders_are_counted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("panda-scan-err-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for f in ["Heat (1995)/Heat (1995).mkv", "Alien (1979)/Alien (1979).mkv"] {
            let p = dir.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"x").unwrap();
        }
        let locked = dir.join("Alien (1979)");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let out = scan_checked(&dir, LibraryKind::Movies);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&dir);
        // Root can read anything: only assert when the folder really was unreadable.
        if out.files.len() == 1 {
            assert_eq!(out.errors, 1, "an unreadable folder makes the walk partial");
        }
    }
}
