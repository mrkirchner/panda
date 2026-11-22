//! Library scanning: walk folders, find video files, parse names into movies/episodes.

pub mod parse;
pub mod scan;

pub use parse::{Parsed, parse_episode, parse_movie};
pub use scan::{LibraryKind, ScanOutcome, ScannedFile, scan, scan_checked};
