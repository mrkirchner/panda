//! The metadata providers Panda knows, what each can supply, and how their answers combine.
//!
//! TMDB always decides *which* title a file is; the others are looked up by the ids TMDB gives
//! (TVDB, `IMDb`) and only supply values. Each provider's answers are stored apart, and the shown
//! value is picked per kind of data by the admin's order ([`Order`]): the first provider with a
//! real value wins. Ratings aren't ordered: every enabled source is shown.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Stored field names (`provider_values.field`), also the ids of the switches for them.
pub const NAME: &str = "name";
pub const OVERVIEW: &str = "overview";
pub const AIR_DATE: &str = "air_date";
/// Artwork: an image cache key (TMDB's, already cached) or an image URL (downloaded once picked).
pub const POSTER: &str = "poster";
pub const BACKDROP: &str = "backdrop";
pub const LOGO: &str = "logo";
/// A value-less answer meaning "the provider knows this title or episode" (it gave no other
/// field), so an episode with no details yet still counts as listed, and a plot it removed
/// clears.
pub const LISTED: &str = "listed";
/// A switch for "episodes only this provider lists" (it adds rows rather than a field).
pub const NEW_EPISODES: &str = "new_episodes";

/// The stored field of a rating from `source` (`imdb` -> `rating.imdb`).
pub fn rating_field(source: &str) -> String {
    format!("rating.{source}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Tmdb,
    Tvmaze,
    Omdb,
    Fanart,
}

/// A kind of data an admin can order providers for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    /// A movie's or show's plot.
    Overview,
    /// Episode names, plots and air dates.
    Episodes,
    Posters,
    Backdrops,
    /// A title's name as transparent artwork (Home's feature cards).
    Logos,
}

impl Field {
    pub const ALL: [Field; 5] =
        [Field::Overview, Field::Episodes, Field::Posters, Field::Backdrops, Field::Logos];

    pub fn label(self) -> &'static str {
        match self {
            Field::Overview => "Plots",
            Field::Episodes => "Episode names, plots and air dates",
            Field::Posters => "Posters",
            Field::Backdrops => "Backdrops",
            Field::Logos => "Logos",
        }
    }
}

/// Everything Panda knows about a provider, in one place. Adding a provider means a variant of
/// [`Provider`], its `Spec` here, and its lookup (`panda-server`'s `services::providers::Extra`).
#[derive(Debug)]
pub struct Spec {
    /// Stored in the database and the settings (never changes).
    pub id: &'static str,
    pub name: &'static str,
    /// For the admin page: what it adds and how often it's asked.
    pub about: &'static str,
    /// The credit its terms ask for, and where it links.
    pub credit: &'static str,
    pub site: &'static str,
    /// `Some`: it needs the admin's own key (how to get one). `None`: just an on/off switch.
    pub key_hint: Option<&'static str>,
    /// The kinds of data it can be ordered for.
    pub supplies: &'static [Field],
    /// The ratings it gives, stored as `rating.<source>` (TMDB's is on the title itself).
    pub ratings: &'static [RatingSource],
    /// Whether an episode name it gives is only a stand-in ("Episode 5"), which loses to a
    /// real name from another provider.
    pub stand_in_name: fn(name: &str, episode: i64) -> bool,
    /// `Some` for a provider that adds to TMDB; `None` for TMDB, the base.
    pub extra: Option<ExtraSpec>,
}

/// One source of ratings a provider gives.
#[derive(Debug)]
pub struct RatingSource {
    /// Stored as `rating.<source>`.
    pub source: &'static str,
    /// "Rotten Tomatoes", and "RT" where space is short (a TV line).
    pub label: &'static str,
    pub short: &'static str,
}

/// What only a provider that adds to TMDB has: how it's asked, and what can be switched off.
#[derive(Debug)]
pub struct ExtraSpec {
    /// Only shows (no movies).
    pub shows_only: bool,
    /// Titles asked per pass, and at once.
    pub per_pass: usize,
    pub concurrency: usize,
    /// What an admin can switch off besides its ratings (each rating can be, too): `(id, label)`,
    /// a stored field name or [`NEW_EPISODES`].
    pub options: &'static [(&'static str, &'static str)],
}

/// A stand-in for an episode not named yet: "Episode 5" for episode 5 (TMDB, TVmaze), "TBA".
fn unnamed_episode(name: &str, episode: i64) -> bool {
    let name = name.trim();
    name.eq_ignore_ascii_case("TBA")
        || name.strip_prefix("Episode ").is_some_and(|rest| rest.trim() == episode.to_string())
}

fn no_stand_ins(_: &str, _: i64) -> bool {
    false
}

const TMDB: Spec = Spec {
    id: "tmdb",
    name: "TMDB",
    about: "Decides which title each file is, and supplies posters, plots and episodes.",
    credit: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    site: "https://www.themoviedb.org",
    key_hint: Some("themoviedb.org, then Settings, then API. Use the long \"API Read Access Token\"."),
    supplies: &[Field::Overview, Field::Episodes, Field::Posters, Field::Backdrops, Field::Logos],
    ratings: &[RatingSource { source: "tmdb", label: "TMDB", short: "TMDB" }],
    stand_in_name: unnamed_episode,
    extra: None,
};

const TVMAZE: Spec = Spec {
    id: "tvmaze",
    name: "TVmaze",
    about: "Fills in what TMDB is missing for TV episodes: names, plots, air dates and episodes TMDB \
            doesn't list. Free, no account or key needed. Shows are looked up a few dozen at a time \
            after each scan, then monthly.",
    credit: "Episode data from TVmaze, licensed CC BY-SA.",
    site: "https://www.tvmaze.com",
    key_hint: None,
    supplies: &[Field::Episodes],
    ratings: &[],
    stand_in_name: unnamed_episode,
    extra: Some(ExtraSpec {
        shows_only: true,
        per_pass: 50,
        concurrency: 2,
        options: &[
            (NAME, "Episode names"),
            (OVERVIEW, "Episode plots"),
            (AIR_DATE, "Air dates"),
            (NEW_EPISODES, "Episodes TMDB doesn't list"),
        ],
    }),
};

const OMDB: Spec = Spec {
    id: "omdb",
    name: "OMDb",
    about: "Adds IMDb, Rotten Tomatoes and Metacritic ratings to title pages, and another plot to \
            choose from. The free key allows 1,000 lookups a day, so titles are looked up 100 at a \
            time after each scan, then monthly. Titles are found by the IMDb id TMDB gives.",
    credit: "Data from OMDb, licensed CC BY-NC 4.0.",
    site: "https://www.omdbapi.com",
    key_hint: Some("Free at omdbapi.com, then API Key. Click the activation link in the email first."),
    supplies: &[Field::Overview],
    ratings: &[
        RatingSource { source: "imdb", label: "IMDb", short: "IMDb" },
        RatingSource { source: "rotten_tomatoes", label: "Rotten Tomatoes", short: "RT" },
        RatingSource { source: "metacritic", label: "Metacritic", short: "MC" },
    ],
    stand_in_name: no_stand_ins,
    extra: Some(ExtraSpec {
        shows_only: false,
        per_pass: 100,
        concurrency: 4,
        options: &[(OVERVIEW, "Plots")],
    }),
};

const FANART: Spec = Spec {
    id: "fanart",
    name: "Fanart.tv",
    about: "More and better artwork: posters, backdrops, and logos (a title's name as artwork, on \
            Home's feature cards) where TMDB has none. Free with a personal key. Titles are looked \
            up 100 at a time after each scan, then monthly; shows by the TVDB id TMDB gives.",
    credit: "Artwork from Fanart.tv.",
    site: "https://fanart.tv",
    key_hint: Some("Free at fanart.tv: sign in, then Profile, then API, and use your personal API key."),
    supplies: &[Field::Posters, Field::Backdrops, Field::Logos],
    ratings: &[],
    stand_in_name: no_stand_ins,
    extra: Some(ExtraSpec {
        shows_only: false,
        per_pass: 100,
        concurrency: 4,
        options: &[(POSTER, "Posters"), (BACKDROP, "Backdrops"), (LOGO, "Logos")],
    }),
};

impl Provider {
    pub const ALL: [Provider; 4] = [Provider::Tmdb, Provider::Tvmaze, Provider::Omdb, Provider::Fanart];

    pub fn spec(self) -> &'static Spec {
        match self {
            Provider::Tmdb => &TMDB,
            Provider::Tvmaze => &TVMAZE,
            Provider::Omdb => &OMDB,
            Provider::Fanart => &FANART,
        }
    }

    /// The providers that add to TMDB (looked up by the ids TMDB gives).
    pub fn extras() -> impl Iterator<Item = Provider> {
        Self::ALL.into_iter().filter(|p| p.spec().extra.is_some())
    }

    /// TMDB: the base everything else adds to.
    pub fn is_base(self) -> bool {
        self.spec().extra.is_none()
    }

    pub fn id(self) -> &'static str {
        self.spec().id
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == id)
    }

    pub fn name(self) -> &'static str {
        self.spec().name
    }

    pub fn supplies(self, field: Field) -> bool {
        self.spec().supplies.contains(&field)
    }

    /// Whether an episode name it gave is a real one (not empty, not a stand-in).
    pub fn real_name(self, name: &str, episode: i64) -> bool {
        !name.trim().is_empty() && !(self.spec().stand_in_name)(name, episode)
    }

    /// What an admin can switch off for this provider: `(id, label)`, each of its ratings
    /// (`rating.imdb`, ...) and its other options. The base (TMDB) has none.
    pub fn options(self) -> Vec<(String, String)> {
        let Some(extra) = &self.spec().extra else { return Vec::new() };
        self.spec()
            .ratings
            .iter()
            .map(|r| (rating_field(r.source), format!("{} rating", r.label)))
            .chain(extra.options.iter().map(|(id, label)| ((*id).to_string(), (*label).to_string())))
            .collect()
    }

    fn has_option(self, option: &str) -> bool {
        self.options().iter().any(|(id, _)| id == option)
    }
}

/// What the admin switched off, per provider (everything is on by default).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Switches {
    off: BTreeMap<Provider, BTreeSet<String>>,
}

impl Switches {
    /// Whether `provider`'s `option` (a field name or [`NEW_EPISODES`]) is used. Anything that
    /// isn't a switch (a field the provider has no switch for) is always used.
    pub fn allows(&self, provider: Provider, option: &str) -> bool {
        !self.off.get(&provider).is_some_and(|off| off.contains(option))
    }

    /// Turn one option on or off. Unknown options are ignored (returns false).
    pub fn set(&mut self, provider: Provider, option: &str, on: bool) -> bool {
        if !provider.has_option(option) {
            return false;
        }
        let off = self.off.entry(provider).or_default();
        if on {
            off.remove(option);
        } else {
            off.insert(option.to_string());
        }
        self.off.retain(|_, o| !o.is_empty());
        true
    }

    /// Drop stored switches that no longer exist.
    #[must_use]
    pub fn normalized(mut self) -> Self {
        for (p, off) in &mut self.off {
            off.retain(|o| p.has_option(o));
        }
        self.off.retain(|_, o| !o.is_empty());
        self
    }
}

/// The admin's provider order per kind of data, best first (JSON: `{"overview": [...], ...}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Order(BTreeMap<Field, Vec<Provider>>);

impl Default for Order {
    /// TMDB first everywhere: the others fill its gaps.
    fn default() -> Self {
        Self(BTreeMap::new()).normalized()
    }
}

impl Order {
    pub fn get(&self, field: Field) -> &[Provider] {
        self.0.get(&field).map_or(&[], Vec::as_slice)
    }

    /// Repair a stored or submitted order: drop providers that can't supply a field and
    /// repeats, then add any missing ones at the end (in the default order), so every provider
    /// that can supply a field is always somewhere in its list.
    #[must_use]
    pub fn normalized(mut self) -> Self {
        let fixed = Field::ALL
            .into_iter()
            .map(|field| {
                let mut out: Vec<Provider> = Vec::new();
                for p in self.0.remove(&field).unwrap_or_default().into_iter().chain(Provider::ALL) {
                    if p.supplies(field) && !out.contains(&p) {
                        out.push(p);
                    }
                }
                (field, out)
            })
            .collect();
        Self(fixed)
    }
}

/// The first real value in `order`. `value(p)` is what `p` said (`None` when it said nothing, or
/// isn't used); `is_real(p, v)` rejects stand-ins (TMDB's "Episode 5"). When no provider has a
/// real value, the first stand-in is better than nothing.
pub fn pick<'a>(
    order: &[Provider],
    value: impl Fn(Provider) -> Option<&'a str>,
    is_real: impl Fn(Provider, &str) -> bool,
) -> Option<&'a str> {
    let said: Vec<(Provider, &'a str)> = order
        .iter()
        .filter_map(|&p| value(p).map(|v| (p, v)))
        .filter(|(_, v)| !v.trim().is_empty())
        .collect();
    said.iter().find(|(p, v)| is_real(*p, v)).or_else(|| said.first()).map(|(_, v)| *v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_order_puts_tmdb_first() {
        let o = Order::default();
        assert_eq!(o.get(Field::Overview), [Provider::Tmdb, Provider::Omdb]);
        assert_eq!(o.get(Field::Episodes), [Provider::Tmdb, Provider::Tvmaze]);
        assert_eq!(
            serde_json::to_string(&o).unwrap(),
            r#"{"overview":["tmdb","omdb"],"episodes":["tmdb","tvmaze"],"posters":["tmdb","fanart"],"backdrops":["tmdb","fanart"],"logos":["tmdb","fanart"]}"#
        );
    }

    #[test]
    fn normalized_repairs_bad_orders() {
        let o =
            serde_json::from_str::<Order>(r#"{"overview":["omdb","tvmaze","omdb"],"episodes":["tvmaze"]}"#)
                .unwrap()
                .normalized();
        assert_eq!(
            o.get(Field::Overview),
            [Provider::Omdb, Provider::Tmdb],
            "TVmaze has no plots; repeats go"
        );
        assert_eq!(
            o.get(Field::Episodes),
            [Provider::Tvmaze, Provider::Tmdb],
            "missing ones are added at the end"
        );
    }

    #[test]
    fn every_extra_rating_can_be_switched_off() {
        for p in Provider::extras() {
            for r in p.spec().ratings {
                let field = rating_field(r.source);
                assert!(p.options().iter().any(|(id, _)| *id == field), "{} {field} has a switch", p.name());
            }
        }
        assert!(Provider::Tmdb.options().is_empty(), "the base has no switches");
        assert_eq!(
            Provider::extras().collect::<Vec<_>>(),
            [Provider::Tvmaze, Provider::Omdb, Provider::Fanart]
        );
    }

    #[test]
    fn stand_in_names_are_the_providers_own() {
        assert!(!Provider::Tmdb.real_name("Episode 5", 5));
        assert!(Provider::Tmdb.real_name("Episode 4", 5), "a real title can look like that");
        assert!(!Provider::Tvmaze.real_name("Episode 5", 5), "TVmaze uses it too");
        assert!(!Provider::Tvmaze.real_name("TBA", 5));
        assert!(!Provider::Tvmaze.real_name("  ", 5));
        assert!(Provider::Omdb.real_name("Episode 5", 5), "OMDb has no episode names to stand in");
    }

    #[test]
    fn switches_turn_single_options_off() {
        let mut s = Switches::default();
        assert!(s.allows(Provider::Omdb, "rating.rotten_tomatoes"));
        assert!(s.set(Provider::Omdb, "rating.rotten_tomatoes", false));
        assert!(!s.allows(Provider::Omdb, "rating.rotten_tomatoes"));
        assert!(s.allows(Provider::Omdb, "rating.imdb"));
        assert!(!s.set(Provider::Omdb, "made.up", false), "unknown options are refused");
        assert!(!s.set(Provider::Tmdb, "overview", false), "TMDB has no switches");
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"omdb":["rating.rotten_tomatoes"]}"#);
        assert!(s.set(Provider::Omdb, "rating.rotten_tomatoes", true));
        assert_eq!(s, Switches::default());
        let stale: Switches = serde_json::from_str(r#"{"tvmaze":["gone","name"]}"#).unwrap();
        assert_eq!(serde_json::to_string(&stale.normalized()).unwrap(), r#"{"tvmaze":["name"]}"#);
    }

    #[test]
    fn pick_takes_the_first_real_value() {
        let order = [Provider::Tmdb, Provider::Tvmaze];
        let said = |p| match p {
            Provider::Tmdb => Some("Episode 5"),
            Provider::Tvmaze => Some("The Real Name"),
            Provider::Omdb | Provider::Fanart => None,
        };
        let real = |p: Provider, v: &str| p.real_name(v, 5);
        assert_eq!(pick(&order, said, real), Some("The Real Name"));
        // TVmaze not used: the stand-in is better than nothing.
        assert_eq!(pick(&order, |p| said(p).filter(|_| p != Provider::Tvmaze), real), Some("Episode 5"));
        assert_eq!(pick(&order, |_| Some("  "), real), None);
    }
}
