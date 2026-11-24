//! Age ratings ("PG-13", "TV-MA", "FSK 16", "12A") as the youngest age they're meant for, so a
//! profile's age limit can be checked against any country's system.
//!
//! TMDB gives each title's ratings per country. The server's region (`[tmdb] region`) is asked
//! first, then the US (TMDB's best covered); a rating no table knows still counts when it carries
//! its age ("16", "12+", "K-12").

use crate::tmdb::{ContentRatings, ReleaseDates};

/// Ratings by country, as the youngest age each is for. Ratings that carry their age ("16",
/// "FSK 12", "12+") need no entry: [`number_in`] reads them.
const TABLE: &[(&str, &[&str], u8)] = &[
    // United States: films (MPA) and TV (TV Parental Guidelines).
    ("US", &["G", "TV-Y", "TV-G"], 0),
    ("US", &["PG", "TV-Y7", "TV-Y7-FV"], 7),
    ("US", &["TV-PG"], 10),
    ("US", &["PG-13"], 13),
    ("US", &["TV-14"], 14),
    ("US", &["R", "TV-MA"], 17),
    ("US", &["NC-17"], 18),
    // United Kingdom (BBFC).
    ("GB", &["U", "UC"], 0),
    ("GB", &["PG"], 8),
    ("GB", &["R18"], 18),
    // Canada (films and TV).
    ("CA", &["G", "C", "E"], 0),
    ("CA", &["PG", "C8"], 8),
    ("CA", &["R", "A"], 18),
    // Australia.
    ("AU", &["G", "P", "C", "E"], 0),
    ("AU", &["PG"], 8),
    ("AU", &["M"], 15),
    // Netherlands (Kijkwijzer), France, Brazil: "all ages" by name.
    ("NL", &["AL"], 0),
    ("FR", &["U", "TP"], 0),
    ("BR", &["L"], 0),
    // New Zealand.
    ("NZ", &["G"], 0),
    ("NZ", &["PG"], 8),
    ("NZ", &["M"], 16),
];

/// The youngest age `cert` (in `country`) is for; `None` when it says nothing usable ("NR",
/// "Unrated", an empty rating).
#[must_use]
pub fn age(country: &str, cert: &str) -> Option<u8> {
    let c = cert.trim().to_ascii_uppercase();
    if c.is_empty() {
        return None;
    }
    let country = country.to_ascii_uppercase();
    TABLE
        .iter()
        .find(|(k, certs, _)| *k == country && certs.contains(&c.as_str()))
        .map(|(_, _, age)| *age)
        .or_else(|| number_in(&c))
}

/// The age a rating spells out: "16", "FSK 16", "12+", "K-12", "-12", "MA15+".
fn number_in(cert: &str) -> Option<u8> {
    let digits: String =
        cert.chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    digits.parse::<u8>().ok().filter(|n| *n <= 21)
}

/// A title's rating as shown ("PG-13") and its age, from `region` else the US.
fn pick(region: &str, find: impl Fn(&str) -> Option<String>) -> Option<(String, u8)> {
    let region = region.to_ascii_uppercase();
    let mut tried = vec![region.as_str()];
    if region != "US" {
        tried.push("US");
    }
    tried.into_iter().find_map(|country| {
        let cert = find(country)?;
        age(country, &cert).map(|a| (cert, a))
    })
}

impl ReleaseDates {
    /// A film's rating in `country`: its first release there that has one.
    #[must_use]
    pub fn in_country(&self, country: &str) -> Option<String> {
        self.results
            .iter()
            .find(|c| c.iso_3166_1.eq_ignore_ascii_case(country))?
            .release_dates
            .iter()
            .filter_map(|r| r.certification.as_deref().map(str::trim))
            .find(|c| !c.is_empty())
            .map(String::from)
    }

    /// The film's rating and age, from `region` else the US.
    #[must_use]
    pub fn rated(&self, region: &str) -> Option<(String, u8)> {
        pick(region, |c| self.in_country(c))
    }
}

impl ContentRatings {
    /// A show's rating in `country`.
    #[must_use]
    pub fn in_country(&self, country: &str) -> Option<String> {
        self.results
            .iter()
            .find(|c| c.iso_3166_1.eq_ignore_ascii_case(country))?
            .rating
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(String::from)
    }

    /// The show's rating and age, from `region` else the US.
    #[must_use]
    pub fn rated(&self, region: &str) -> Option<(String, u8)> {
        pick(region, |c| self.in_country(c))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratings_become_ages() {
        assert_eq!(age("US", "PG-13"), Some(13));
        assert_eq!(age("us", "tv-ma"), Some(17));
        assert_eq!(age("US", "TV-Y"), Some(0));
        assert_eq!(age("US", "NR"), None);
        assert_eq!(age("GB", "12A"), Some(12));
        assert_eq!(age("DE", "16"), Some(16), "FSK numbers");
        assert_eq!(age("DE", "FSK 6"), Some(6));
        assert_eq!(age("FR", "TP"), Some(0));
        assert_eq!(age("FR", "-12"), Some(12));
        assert_eq!(age("KR", "15"), Some(15));
        assert_eq!(age("JP", "PG12"), Some(12));
        assert_eq!(age("AU", "MA15+"), Some(15));
        assert_eq!(age("XX", "Unrated"), None);
        assert_eq!(age("US", ""), None);
    }

    #[test]
    fn the_region_first_then_the_us() {
        let json = serde_json::json!({ "results": [
            { "iso_3166_1": "US", "release_dates": [{ "certification": "" }, { "certification": "R" }] },
            { "iso_3166_1": "DE", "release_dates": [{ "certification": "16" }] },
        ]});
        let r: ReleaseDates = serde_json::from_value(json).unwrap();
        assert_eq!(r.rated("DE"), Some(("16".into(), 16)));
        assert_eq!(r.rated("FR"), Some(("R".into(), 17)), "no French rating: the US one");
        let tv: ContentRatings = serde_json::from_value(
            serde_json::json!({ "results": [{ "iso_3166_1": "US", "rating": "TV-14" }] }),
        )
        .unwrap();
        assert_eq!(tv.rated("us"), Some(("TV-14".into(), 14)));
        assert_eq!(ContentRatings::default().rated("US"), None);
    }
}
