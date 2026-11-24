//! Where an episode's intro and credits are, for "Skip intro" and "Up next".
//!
//! Two sources:
//! - chapters the file names ("Intro", "Opening", "Credits", "Ending"): read with the probe,
//!   free and exact, but most files have none;
//! - audio shared by a season's episodes: the theme song plays in every episode, so the stretch of
//!   sound two neighbouring episodes have in common near their start is the intro, and near their
//!   end, the credits. Each episode's sound is fingerprinted with ffmpeg's `chromaprint` muxer
//!   (jellyfin-ffmpeg has it; a stock ffmpeg may not, and then only chapters count), reading only
//!   the start and the end of the file, never all of it.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::ffmpeg::{self, FfmpegPaths};
use crate::probe::Chapter;

/// Seconds of sound per fingerprint point (chromaprint: 4096-sample frames at 11025 Hz, a third
/// apart).
pub const POINT_SECS: f64 = 4096.0 / 3.0 / 11025.0;

/// Where to skip to and from, in the file's time (seconds).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Markers {
    pub intro_start: Option<f64>,
    pub intro_end: Option<f64>,
    pub credits_start: Option<f64>,
}

impl Markers {
    /// `self`'s values, each filled from `other` where `self` has none.
    #[must_use]
    pub fn or(self, other: Markers) -> Markers {
        let intro = match (self.intro_start, self.intro_end) {
            (Some(s), Some(e)) => (Some(s), Some(e)),
            _ => (other.intro_start, other.intro_end),
        };
        Markers {
            intro_start: intro.0,
            intro_end: intro.1,
            credits_start: self.credits_start.or(other.credits_start),
        }
    }
}

/// Letters only, lowercase: "End Credits" -> "endcredits".
fn squash(title: &str) -> String {
    title.chars().filter(char::is_ascii_alphabetic).collect::<String>().to_ascii_lowercase()
}

/// An intro chapter's title: "Intro", "Opening", "OP", "Opening Credits", "Title Sequence".
fn is_intro(title: &str) -> bool {
    let t = squash(title);
    matches!(
        t.as_str(),
        "intro"
            | "op"
            | "opening"
            | "openingcredits"
            | "openingtitles"
            | "titlesequence"
            | "maintitle"
            | "maintitles"
            | "introsong"
            | "openingsong"
            | "theme"
            | "themesong"
    )
}

/// A credits chapter's title: "Credits", "End Credits", "Ending", "ED", "Outro".
fn is_credits(title: &str) -> bool {
    let t = squash(title);
    matches!(
        t.as_str(),
        "credits"
            | "endcredits"
            | "closingcredits"
            | "ending"
            | "ed"
            | "outro"
            | "endingsong"
            | "endtitles"
            | "endingcredits"
    )
}

/// The markers a file's chapters name. An intro chapter counts in the first 40% of the file and
/// lasting 5 s to 5 min; a credits chapter from halfway on.
#[must_use]
pub fn from_chapters(chapters: &[Chapter], duration: Option<f64>) -> Markers {
    let duration = duration.or_else(|| chapters.last().map(|c| c.end)).unwrap_or(0.0);
    let mut m = Markers::default();
    if duration <= 0.0 {
        return m;
    }
    for c in chapters {
        let Some(title) = c.title.as_deref() else { continue };
        let len = c.end - c.start;
        if m.intro_start.is_none()
            && is_intro(title)
            && c.start < duration * 0.4
            && (5.0..=300.0).contains(&len)
        {
            m.intro_start = Some(c.start);
            m.intro_end = Some(c.end);
        }
        if m.credits_start.is_none() && is_credits(title) && c.start >= duration * 0.5 {
            m.credits_start = Some(c.start);
        }
    }
    m
}

/// Whether this ffmpeg can fingerprint sound (the `chromaprint` muxer).
pub async fn can_fingerprint(paths: &FfmpegPaths) -> bool {
    ffmpeg::run(&paths.ffmpeg, &["-hide_banner", "-muxers"])
        .await
        .is_ok_and(|out| out.lines().any(|l| l.split_whitespace().nth(1) == Some("chromaprint")))
}

/// ffmpeg arguments fingerprinting `secs` of the first audio track from `from` (a seek: only that
/// part is read), as raw 32-bit points on stdout.
#[must_use]
pub fn fingerprint_args(input: &Path, from: f64, secs: f64) -> Vec<String> {
    [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-ss",
        &format!("{from:.3}"),
        "-t",
        &format!("{secs:.3}"),
        "-i",
        &input.to_string_lossy(),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-f",
        "chromaprint",
        "-fp_format",
        "raw",
        "-",
    ]
    .iter()
    .map(ToString::to_string)
    .collect()
}

/// Fingerprint `secs` of `input`'s sound from `from`.
pub async fn fingerprint(paths: &FfmpegPaths, input: &Path, from: f64, secs: f64) -> Result<Vec<u32>> {
    let args = fingerprint_args(input, from, secs);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(points(&ffmpeg::run_bytes(&paths.ffmpeg, &refs).await?))
}

/// Raw chromaprint output (little-endian 32-bit points) as points.
#[must_use]
pub fn points(raw: &[u8]) -> Vec<u32> {
    raw.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// A stretch two fingerprints share: where it is in each (seconds from their starts).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shared {
    pub a: (f64, f64),
    pub b: (f64, f64),
}

impl Shared {
    #[must_use]
    pub fn secs(&self) -> f64 {
        self.a.1 - self.a.0
    }
}

/// Points this close (differing bits) are the same sound.
const MAX_BIT_DIFF: u32 = 6;
/// A stretch may have quieter gaps this long that don't match (dialogue over the theme).
const MAX_GAP_SECS: f64 = 3.5;
/// A point value seen more often than this in one fingerprint is noise (silence, a hum).
const MAX_REPEATS: usize = 10;
/// Alignments tried, by how many points match exactly there.
const CANDIDATES: usize = 6;

/// The longest stretch of sound `a` and `b` share, `min_secs` to `max_secs` long.
#[must_use]
pub fn shared(a: &[u32], b: &[u32], min_secs: f64, max_secs: f64) -> Option<Shared> {
    // Where each value is in `b`, then how often each shift (b index - a index) lines up.
    let mut index: HashMap<u32, Vec<usize>> = HashMap::new();
    for (j, v) in b.iter().enumerate() {
        index.entry(*v).or_default().push(j);
    }
    let mut shifts: HashMap<isize, usize> = HashMap::new();
    for (i, v) in a.iter().enumerate() {
        let Some(js) = index.get(v) else { continue };
        if js.len() > MAX_REPEATS {
            continue;
        }
        for &j in js {
            #[allow(clippy::cast_possible_wrap)]
            let shift = j as isize - i as isize;
            *shifts.entry(shift).or_default() += 1;
        }
    }
    let mut ranked: Vec<(isize, usize)> = shifts.into_iter().filter(|(_, n)| *n >= 3).collect();
    ranked.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
    let mut tried: Vec<isize> = Vec::new();
    let mut best: Option<Shared> = None;
    for (shift, _) in ranked.into_iter().take(CANDIDATES) {
        // Two encodes of the same sound can line up a point apart.
        for s in [shift - 1, shift, shift + 1] {
            if tried.contains(&s) {
                continue;
            }
            tried.push(s);
            if let Some(found) = run_at(a, b, s)
                && (min_secs..=max_secs).contains(&found.secs())
                && best.is_none_or(|b| found.secs() > b.secs())
            {
                best = Some(found);
            }
        }
    }
    best
}

/// The longest matching run with `b` shifted by `shift` points against `a`.
fn run_at(a: &[u32], b: &[u32], shift: isize) -> Option<Shared> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let gap = (MAX_GAP_SECS / POINT_SECS) as usize;
    let mut best: Option<(usize, usize)> = None;
    let mut run: Option<(usize, usize)> = None;
    for (i, av) in a.iter().enumerate() {
        #[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
        let Some(bv) = usize::try_from(i as isize + shift).ok().and_then(|j| b.get(j)) else { continue };
        if (av ^ bv).count_ones() > MAX_BIT_DIFF {
            continue;
        }
        run = match run {
            Some((start, last)) if i - last <= gap => Some((start, i)),
            _ => Some((i, i)),
        };
        if let Some((s, e)) = run
            && best.is_none_or(|(bs, be)| e - s > be - bs)
        {
            best = Some((s, e));
        }
    }
    let (s, e) = best?;
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    let at = |i: usize| i as f64 * POINT_SECS;
    #[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    let (bs, be) = ((s as isize + shift) as usize, (e as isize + shift) as usize);
    Some(Shared { a: (at(s), at(e + 1)), b: (at(bs), at(be + 1)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(start: f64, end: f64, title: &str) -> Chapter {
        Chapter { start, end, title: Some(title.into()) }
    }

    #[test]
    fn named_chapters_give_markers() {
        // As a real WEB-DL names them: Scene 1, Intro, Scene 2, Credits.
        let ch = [
            chapter(0.0, 95.0, "Scene 1"),
            chapter(95.0, 125.0, "Intro"),
            chapter(125.0, 2500.0, "Scene 2"),
            chapter(2500.0, 2600.0, "Credits"),
        ];
        let m = from_chapters(&ch, Some(2600.0));
        assert_eq!(
            m,
            Markers { intro_start: Some(95.0), intro_end: Some(125.0), credits_start: Some(2500.0) }
        );
        // Blu-ray numbering says nothing; an opening scene named "(Credits)" isn't the end credits.
        let blu = [chapter(0.0, 300.0, "Chapter 01"), chapter(300.0, 600.0, "To the Rescue (Credits)")];
        assert_eq!(from_chapters(&blu, Some(6000.0)), Markers::default());
        assert!(is_credits("End Credits") && is_credits("ED") && !is_credits("Credits Roll Scene 4"));
    }

    #[test]
    fn chapters_fill_in_what_audio_lacks() {
        let audio = Markers { intro_start: Some(10.0), intro_end: Some(40.0), credits_start: None };
        let chapters = Markers { intro_start: None, intro_end: None, credits_start: Some(2500.0) };
        assert_eq!(
            chapters.or(audio),
            Markers { intro_start: Some(10.0), intro_end: Some(40.0), credits_start: Some(2500.0) }
        );
    }

    /// Fake sound: random points, with a "theme" pasted in at different places, slightly altered
    /// (as two encodes of the same song come out).
    fn noise(seed: &mut u64, n: usize) -> Vec<u32> {
        (0..n)
            .map(|_| {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                #[allow(clippy::cast_possible_truncation)]
                let v = *seed as u32;
                v
            })
            .collect()
    }

    #[test]
    fn the_theme_two_episodes_share_is_found() {
        let mut seed = 0x9e37_79b9_7f4a_7c15;
        let theme = noise(&mut seed, 400); // ~50 s
        let mut a = noise(&mut seed, 1000);
        let mut b = noise(&mut seed, 1600);
        a.splice(200..200, theme.iter().copied());
        // In b later, a few bits off in places.
        b.splice(900..900, theme.iter().enumerate().map(|(i, v)| if i % 5 == 0 { v ^ 0b101 } else { *v }));
        let found = shared(&a, &b, 15.0, 150.0).expect("found");
        let near = |x: f64, y: f64| (x - y).abs() < 1.0;
        assert!(near(found.a.0, 200.0 * POINT_SECS) && near(found.a.1, 600.0 * POINT_SECS), "{found:?}");
        assert!(near(found.b.0, 900.0 * POINT_SECS), "{found:?}");
        // Nothing shared: nothing found.
        let c = noise(&mut seed, 1500);
        assert_eq!(shared(&a[..190], &c, 15.0, 150.0), None);
    }

    #[test]
    fn raw_output_is_little_endian_points() {
        assert_eq!(points(&[1, 0, 0, 0, 0xff, 0, 0, 0x80, 9]), vec![1, 0x8000_00ff]);
        let args = fingerprint_args(Path::new("/m/a.mkv"), 1.5, 600.0).join(" ");
        assert!(
            args.starts_with("-hide_banner -v error -nostdin -ss 1.500 -t 600.000 -i /m/a.mkv -map 0:a:0"),
            "{args}"
        );
        assert!(args.ends_with("-f chromaprint -fp_format raw -"));
    }
}
