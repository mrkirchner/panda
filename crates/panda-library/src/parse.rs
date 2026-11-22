//! Filename parsing using the same conventions Sonarr/Radarr write:
//! `Movie Title (2019)/Movie Title (2019) - 1080p.mkv`
//! `Show Name/Season 01/Show Name - S01E02 - Episode Title.mkv`
//!
//! Plus the messier layouts real libraries have: year-numbered seasons (`S2025E02`), absolute
//! numbering (`Kill La Kill - 11`), compilations (`Brotherhood 14-22`) and title-only files
//! (`The Muppet Show/Season 1/Twiggy.m4v`, numbered later by matching names against TMDB).

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Parsed {
    Movie {
        title: String,
        year: Option<u16>,
    },
    Episode {
        series: String,
        season: u32,
        /// `None` for title-only files. Resolved later by matching `episode_title` against TMDB.
        episode: Option<u32>,
        episode_end: Option<u32>,
        /// Title taken from the file name, when the name is just a title.
        episode_title: Option<String>,
    },
}

static EPISODE_SXXEXX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?P<series>.*?)[ ._\-\[]*s(?P<s>\d{1,4})[ ._]?e(?P<e>\d{1,3})(?:-?e(?P<e2>\d{1,3}))?")
        .unwrap()
});
static EPISODE_NXNN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?P<series>.*?)[ ._\-]+(?P<s>\d{1,2})x(?P<e>\d{2,3})\b").unwrap());
/// Candidate release years. Boundaries are checked in code because `regex` has no lookaround
/// and adjacent years (`2049.2017`) share a separator.
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:19|20)\d{2}").unwrap());
/// `Show - 11`, `Show 14-22`: a trailing absolute episode number or range.
static EPISODE_ABSOLUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?P<series>.*?)[ ._\-]+(?:ep?[ ._]?)?(?P<e>\d{1,4})(?:[ ]?-[ ]?(?P<e2>\d{1,4}))?$").unwrap()
});
static SEASON_DIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:season|series|s)[ ._]?(?P<n>\d+)$|^(?P<specials>specials)$").unwrap()
});
/// Resolutions and codecs that look like trailing numbers but aren't episodes.
const NOT_EPISODE_NUMBERS: &[&str] = &["480", "576", "720", "1080", "2160", "264", "265"];
static YEAR_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\((?:19|20)\d{2}\)$").unwrap());

pub fn parse_episode(path: &Path) -> Option<Parsed> {
    let stem = path.file_stem()?.to_string_lossy();
    let num = |m: Option<regex::Match<'_>>| m.and_then(|m| m.as_str().parse::<u32>().ok());

    // 1. SxxEyy / NxNN: everything is in the name.
    if let Some(caps) = EPISODE_SXXEXX.captures(&stem).or_else(|| EPISODE_NXNN.captures(&stem)) {
        let series =
            Some(clean(&caps["series"])).filter(|s| !s.is_empty()).or_else(|| series_from_dirs(path))?;
        return Some(Parsed::Episode {
            series,
            season: caps["s"].parse().ok()?,
            episode: Some(caps["e"].parse().ok()?),
            episode_end: num(caps.name("e2")),
            episode_title: None,
        });
    }

    // Remaining layouts need the folder structure for the series (and maybe the season).
    let series = series_from_dirs(path)?;
    let season = season_from_dir(path);

    // 2. Absolute numbering / ranges.
    if let Some(caps) = EPISODE_ABSOLUTE.captures(&stem)
        && !NOT_EPISODE_NUMBERS.contains(&&caps["e"])
    {
        return Some(Parsed::Episode {
            series,
            season: season.unwrap_or(1),
            episode: num(caps.name("e")),
            episode_end: num(caps.name("e2")),
            episode_title: None,
        });
    }

    // 3. Title-only, but only inside a season folder (otherwise it's probably an extra).
    let season = season?;
    let title = clean(&stem);
    (!title.is_empty()).then_some(Parsed::Episode {
        series,
        season,
        episode: None,
        episode_end: None,
        episode_title: Some(title),
    })
}

fn season_from_dir(path: &Path) -> Option<u32> {
    let dir = path.parent()?.file_name()?.to_string_lossy();
    let caps = SEASON_DIR.captures(&dir)?;
    if caps.name("specials").is_some() { Some(0) } else { caps["n"].parse().ok() }
}

pub fn parse_movie(path: &Path) -> Parsed {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(p) = movie_from_name(&stem) {
        return p;
    }
    // `Movie (2019)/movie.mkv`: fall back to the folder name.
    if let Some(dir) = path.parent().and_then(|p| p.file_name()).map(|d| d.to_string_lossy())
        && let Some(p) = movie_from_name(&dir)
    {
        return p;
    }
    Parsed::Movie { title: clean(&stem), year: None }
}

/// The title is everything before the *last* standalone year:
/// `Blade Runner 2049 (2017)` -> (`Blade Runner 2049`, 2017).
fn movie_from_name(name: &str) -> Option<Parsed> {
    let is_sep =
        |c: Option<char>| c.is_none_or(|c| matches!(c, ' ' | '.' | '_' | '-' | '(' | ')' | '[' | ']'));
    YEAR.find_iter(name)
        .filter(|m| is_sep(name[..m.start()].chars().next_back()) && is_sep(name[m.end()..].chars().next()))
        .filter_map(|m| {
            let title = clean(&name[..m.start()]);
            (!title.is_empty()).then(|| Parsed::Movie { title, year: m.as_str().parse().ok() })
        })
        .last()
}

/// `Show/Season 1/S01E02.mkv` -> `Show`
fn series_from_dirs(path: &Path) -> Option<String> {
    let mut dirs = path.ancestors().skip(1).filter_map(|p| p.file_name()).map(|n| n.to_string_lossy());
    let first = dirs.next()?;
    let name = if SEASON_DIR.is_match(&first) { dirs.next()? } else { first };
    Some(YEAR_SUFFIX.replace(&clean(&name), "").into_owned())
}

/// `[Group]` / `[1080p]` tags from release names.
static BRACKET_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]").unwrap());

fn clean(s: &str) -> String {
    let s = BRACKET_TAG.replace_all(s, " ").replace(['.', '_'], " ");
    s.trim().trim_end_matches(['-', '[', '(', ' ']).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(p: &str) -> Option<(String, u32, u32, Option<u32>)> {
        match parse_episode(Path::new(p))? {
            Parsed::Episode { series, season, episode, episode_end, .. } => {
                Some((series, season, episode?, episode_end))
            }
            Parsed::Movie { .. } => None,
        }
    }

    fn movie(p: &str) -> (String, Option<u16>) {
        match parse_movie(Path::new(p)) {
            Parsed::Movie { title, year } => (title, year),
            Parsed::Episode { .. } => unreachable!(),
        }
    }

    #[test]
    fn sonarr_style_episode() {
        assert_eq!(
            ep("/tv/The Expanse/Season 01/The Expanse - S01E02 - The Big Empty.mkv"),
            Some(("The Expanse".into(), 1, 2, None))
        );
    }

    #[test]
    fn scene_style_and_multi_episode() {
        assert_eq!(ep("/tv/Show.Name.S03E09E10.1080p.WEB.mkv"), Some(("Show Name".into(), 3, 9, Some(10))));
        assert_eq!(ep("/tv/Show Name - 2x05.avi"), Some(("Show Name".into(), 2, 5, None)));
    }

    #[test]
    fn bare_episode_uses_folder_names() {
        assert_eq!(ep("/tv/Severance (2022)/Season 2/S02E01.mkv"), Some(("Severance".into(), 2, 1, None)));
    }

    #[test]
    fn strips_release_group_tags() {
        assert_eq!(
            ep("/tv/[Sokudo] Food Wars/Season 1/[Sokudo] Food Wars - S01E03 [1080p].mkv"),
            Some(("Food Wars".into(), 1, 3, None))
        );
    }

    #[test]
    fn year_numbered_seasons() {
        assert_eq!(
            ep("/tv/Reel Rock/Reel Rock - S2025E02 - Riders On The Storm WEBRip-1080p.mkv"),
            Some(("Reel Rock".into(), 2025, 2, None))
        );
    }

    #[test]
    fn absolute_numbering_and_ranges() {
        assert_eq!(ep("/tv/Kill La Kill/Kill La Kill - 11.m4v"), Some(("Kill La Kill".into(), 1, 11, None)));
        assert_eq!(
            ep("/tv/Fullmetal Alchemist Brotherhood/Season 1/Fullmetal Alchemist_ Brotherhood 14-22.m4v"),
            Some(("Fullmetal Alchemist Brotherhood".into(), 1, 14, Some(22)))
        );
        assert_eq!(
            ep("/tv/Dragon Ball Z/Season 1/Dragon Ball Z 1-7.m4v"),
            Some(("Dragon Ball Z".into(), 1, 1, Some(7)))
        );
        // A trailing resolution is not an episode number.
        assert_eq!(parse_episode(Path::new("/tv/Show/Show 1080.mkv")), None);
    }

    #[test]
    fn title_only_files_inside_season_folders() {
        assert_eq!(
            parse_episode(Path::new("/tv/The Muppet Show/Season 1/Candice Bergen.m4v")),
            Some(Parsed::Episode {
                series: "The Muppet Show".into(),
                season: 1,
                episode: None,
                episode_end: None,
                episode_title: Some("Candice Bergen".into()),
            })
        );
        // Without a season folder a bare title is ignored (likely an extra/featurette).
        assert_eq!(parse_episode(Path::new("/tv/The Muppet Show/Behind the scenes.m4v")), None);
    }

    #[test]
    fn not_an_episode() {
        assert_eq!(ep("/movies/Heat (1995)/Heat (1995).mkv"), None);
    }

    #[test]
    fn movies() {
        assert_eq!(movie("/m/Heat (1995)/Heat (1995) - Bluray-1080p.mkv"), ("Heat".into(), Some(1995)));
        assert_eq!(
            movie("/m/Blade.Runner.2049.2017.2160p.UHD.mkv"),
            ("Blade Runner 2049".into(), Some(2017))
        );
        assert_eq!(movie("/m/Arrival (2016)/movie.mkv"), ("Arrival".into(), Some(2016)));
        assert_eq!(movie("/m/home_video.mp4"), ("home video".into(), None));
        assert_eq!(movie("/m/2001 A Space Odyssey (1968).mkv"), ("2001 A Space Odyssey".into(), Some(1968)));
    }
}
