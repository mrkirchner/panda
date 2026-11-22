//! Pick the right TMDB result for a parsed title + year.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::tmdb::{SearchMovie, SearchTv};

/// Titles this similar (normalized Levenshtein on [`canonical`] forms) count as the same.
/// Catches romanization differences (`Haikyuu!!` / `Haikyu!!`) without merging short titles
/// that merely share a prefix (`The Office` / `The Offer`).
const FUZZY_THRESHOLD: f64 = 0.85;
const STOPWORDS: &[&str] = &["the", "a", "an", "of", "and"];

/// [`normalize`]d, minus stopwords, with simple plurals folded (`hills` -> `hill`).
fn canonical(s: &str) -> String {
    normalize(s)
        .split(' ')
        .filter(|w| !STOPWORDS.contains(w))
        .map(|w| if w.len() > 3 { w.strip_suffix('s').unwrap_or(w) } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Query variants to try, best first. Radarr/Sonarr replace `:` with ` - ` in folder names
/// (`2001 - A Space Odyssey`), so the colon form is tried first.
pub fn query_variants(title: &str) -> Vec<String> {
    // macOS/SMB file names are often NFD (`e` + combining accent); TMDB search expects NFC.
    let title: String = title.nfc().collect();
    let title = title.as_str();
    let mut out = Vec::new();
    if title.contains(" - ") {
        out.push(title.replacen(" - ", ": ", 1));
    }
    out.push(title.to_string());
    // `Show Name (US)` / `Show (2019)` style disambiguators confuse TMDB search.
    if let Some(stripped) = title.rsplit_once(" (").map(|(t, _)| t.to_string())
        && !stripped.is_empty()
    {
        out.push(stripped);
    }
    // Last resort: TMDB search is literal, so `Fog Hills of the Five Elements` finds nothing
    // while `fog hill five elements` finds `Fog Hill of Five Elements`.
    let loose = canonical(title);
    if !loose.is_empty() && !out.iter().any(|q| normalize(q) == loose) {
        out.push(loose);
    }
    out.dedup();
    out
}

/// The year at the end of a show folder's name (`Monster (2022)`, Sonarr's way of telling two
/// shows of one name apart), if any.
pub fn folder_year(name: &str) -> Option<u16> {
    let inner = name.trim_end().strip_suffix(')')?.rsplit_once('(')?.1;
    let year: u16 = inner.trim().parse().ok().filter(|_| inner.trim().len() == 4)?;
    (1900..=2100).contains(&year).then_some(year)
}

/// Lowercase, accents stripped, `&` -> `and`, punctuation dropped, whitespace collapsed.
pub fn normalize(s: &str) -> String {
    s.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
        .replace('&', " and ")
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn year_of(date: Option<&str>) -> Option<u16> {
    date.and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
}

/// Score one candidate. `None` means "reject".
fn score(
    want_title: &str,
    want_year: Option<u16>,
    titles: &[Option<&str>],
    date: Option<&str>,
    popularity: f64,
) -> Option<f64> {
    let want = canonical(want_title);
    let similarity = titles
        .iter()
        .flatten()
        .map(|t| strsim::normalized_levenshtein(&canonical(t), &want))
        .fold(0.0, f64::max);
    let title_match = similarity >= FUZZY_THRESHOLD;
    let year = year_of(date);
    let year_score = match (want_year, year) {
        (Some(w), Some(y)) if w == y => 2.0,
        // Release dates differ by region/festival; one year off is common.
        (Some(w), Some(y)) if w.abs_diff(y) == 1 => 1.0,
        (Some(_), Some(_)) => return None,
        _ => 0.0,
    };
    // Another title entirely needs the very year (a year off alone once matched `A Loud House
    // Christmas Movie` for `The Loud House Movie (2026)`).
    if !title_match && year_score < 2.0 {
        return None;
    }
    // Popularity only breaks ties.
    // Exact titles beat fuzzy ones; popularity only breaks ties.
    Some(similarity * 3.0 + year_score + popularity.min(1000.0) / 10_000.0)
}

pub fn best_movie<'a>(title: &str, year: Option<u16>, results: &'a [SearchMovie]) -> Option<&'a SearchMovie> {
    results
        .iter()
        .filter_map(|m| {
            score(
                title,
                year,
                &[Some(&m.title), m.original_title.as_deref()],
                m.release_date.as_deref(),
                m.popularity,
            )
            .map(|s| (s, m))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, m)| m)
}

pub fn best_tv<'a>(title: &str, year: Option<u16>, results: &'a [SearchTv]) -> Option<&'a SearchTv> {
    results
        .iter()
        .filter_map(|t| {
            score(
                title,
                year,
                &[Some(&t.name), t.original_name.as_deref()],
                t.first_air_date.as_deref(),
                t.popularity,
            )
            .map(|s| (s, t))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, t)| t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_show_folders_year_is_read() {
        assert_eq!(folder_year("Monster (2022)"), Some(2022));
        assert_eq!(folder_year("Monster"), None);
        assert_eq!(folder_year("The Office (US)"), None);
        assert_eq!(folder_year("Blade Runner 2049"), None);
        assert_eq!(folder_year("Show (12345)"), None);
    }

    #[test]
    fn a_show_folders_year_picks_the_show_of_that_year() {
        let tv = |id, name: &str, date: &str, popularity| SearchTv {
            id,
            name: name.into(),
            original_name: None,
            first_air_date: Some(date.into()),
            overview: None,
            poster_path: None,
            popularity,
            vote_average: None,
        };
        let results = [tv(30981, "Monster", "2004-04-07", 90.0), tv(113_988, "Monster", "2022-09-21", 40.0)];
        assert_eq!(best_tv("Monster", Some(2022), &results).map(|t| t.id), Some(113_988));
        assert_eq!(best_tv("Monster", None, &results).map(|t| t.id), Some(30981), "no year: most popular");
    }

    fn movie(id: i64, title: &str, date: &str, pop: f64) -> SearchMovie {
        SearchMovie {
            id,
            title: title.into(),
            original_title: None,
            release_date: Some(date.into()),
            popularity: pop,
            overview: None,
            poster_path: None,
            vote_average: None,
        }
    }

    #[test]
    fn variants_handle_radarr_colon_substitution() {
        assert_eq!(
            query_variants("2001 - A Space Odyssey"),
            ["2001: A Space Odyssey", "2001 - A Space Odyssey", "2001 space odyssey"]
        );
        assert_eq!(query_variants("Ghosts (US)"), ["Ghosts (US)", "Ghosts", "ghost us"]);
        assert_eq!(query_variants("Heat"), ["Heat"]);
        assert_eq!(query_variants("Fog Hills of the Five Elements").last().unwrap(), "fog hill five element");
    }

    #[test]
    fn normalizes_punctuation() {
        assert_eq!(normalize("Alien: Earth"), normalize("Alien - Earth"));
        assert_eq!(normalize("Law & Order"), "law and order");
    }

    #[test]
    fn prefers_exact_title_and_year_over_popularity() {
        let results = [
            movie(1, "Dune", "1984-12-14", 50.0),
            movie(2, "Dune", "2021-09-15", 400.0),
            movie(3, "Dune: Part Two", "2024-02-27", 900.0),
        ];
        assert_eq!(best_movie("Dune", Some(1984), &results).unwrap().id, 1);
        assert_eq!(best_movie("Dune", Some(2021), &results).unwrap().id, 2);
    }

    #[test]
    fn accents_and_unicode_forms_match() {
        // NFD input, as macOS/SMB file names often are.
        let nfd = "Poke\u{301}mon Detective Pikachu";
        let results = [movie(7, "Pokémon Detective Pikachu", "2019-05-03", 50.0)];
        assert_eq!(best_movie(nfd, Some(2019), &results).unwrap().id, 7);
        assert_eq!(query_variants(nfd)[0], "Pokémon Detective Pikachu");
    }

    #[test]
    fn fuzzy_titles_match_but_unrelated_ones_do_not() {
        let tv = |id, name: &str| SearchTv {
            id,
            name: name.into(),
            original_name: None,
            first_air_date: None,
            popularity: 1.0,
            overview: None,
            poster_path: None,
            vote_average: None,
        };
        let results = [tv(1, "Haikyu!!"), tv(2, "Hajime no Ippo")];
        assert_eq!(best_tv("Haikyuu!!", None, &results).unwrap().id, 1);
        let results = [tv(3, "Fog Hill of Five Elements")];
        assert_eq!(best_tv("Fog Hills of the Five Elements", None, &results).unwrap().id, 3);
        assert!(best_tv("The Office", None, &[tv(4, "The Offer")]).is_none());
    }

    #[test]
    fn another_title_a_year_off_is_no_match() {
        let other = [movie(1, "A Loud House Christmas Movie: Naughty or Nice", "2025-11-26", 30.0)];
        assert!(best_movie("The Loud House Movie", Some(2026), &other).is_none());
    }

    #[test]
    fn rejects_wrong_year_and_tolerates_off_by_one() {
        let results = [movie(1, "Heat", "1995-12-15", 10.0)];
        assert!(best_movie("Heat", Some(2013), &results).is_none());
        assert_eq!(best_movie("Heat", Some(1996), &results).unwrap().id, 1);
    }
}
