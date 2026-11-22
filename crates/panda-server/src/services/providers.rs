//! Extra metadata providers (TVmaze, OMDb) next to TMDB: their answers are stored per provider
//! (`provider_values`), and the shown plot and episode text are picked from them by the admin's
//! order (`settings::METADATA_ORDER`) and switches (`settings::PROVIDER_SWITCHES`), see
//! `panda_metadata::providers`. Changing either, or turning a provider off, re-picks from what's
//! stored, with no new lookups.
//!
//! TMDB's answers are recorded as titles are matched (`services::metadata`). The extra providers
//! are asked in the background after each metadata pass, a limited number of titles at a time,
//! and again monthly, or sooner when a show gets new episodes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use panda_db::{Artwork, MetadataKind, NewEpisode, NewMetadata, ProviderValue, ShownEpisode, StaleTitle};
use panda_metadata::providers::{
    AIR_DATE, BACKDROP, LISTED, LOGO, NAME, NEW_EPISODES, OVERVIEW, POSTER, pick, rating_field,
};
use panda_metadata::tmdb::ExternalIds;
use panda_metadata::{Fanart, Field, ImageSize, Omdb, Provider, Tmdb, TvMaze, matching};
use serde::Serialize;

use crate::services::settings::now;
use crate::state::{AppState, Integrations};

/// Extra providers are asked again after this long.
const REFRESH_SECS: i64 = 30 * 24 * 3600;
/// A lookup that failed (not a rate limit) is tried again after this long, behind titles never
/// asked, so a few broken titles can't fill every pass.
const RETRY_FAILED_SECS: i64 = 24 * 3600;
/// One pass of lookups at a time: a pass started while another runs waits, then finds the
/// titles the first one asked about already fresh (so nothing is asked twice).
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Why an extra provider can't be set up yet (the admin page shows it; the server refuses).
pub(crate) const NEEDS_TMDB: &str = "Set up TMDB first";

impl Integrations {
    pub fn provider_enabled(&self, p: Provider) -> bool {
        if p.is_base() { self.tmdb.is_some() } else { self.extras.contains_key(&p) }
    }

    /// Whether `p`'s stored answers for `option` (a field name or `NEW_EPISODES`) count: the
    /// provider is on and the admin hasn't switched that off. The base's (TMDB's) always count,
    /// even while its token is missing: removing the token mustn't wipe what's shown.
    pub fn uses(&self, p: Provider, option: &str) -> bool {
        p.is_base() || (self.provider_enabled(p) && self.switches.allows(p, option))
    }

    /// Whether `p` is worth asking at all (on, with at least one of its options on).
    pub fn asks(&self, p: Provider) -> bool {
        let options = p.options();
        self.provider_enabled(p)
            && (options.is_empty() || options.iter().any(|(o, _)| self.switches.allows(p, o)))
    }

    /// Why `p` can't be set up yet: an extra provider needs TMDB (titles are found by its ids).
    pub fn blocked_by(&self, p: Provider) -> Option<&'static str> {
        (!p.is_base() && self.tmdb.is_none()).then_some(NEEDS_TMDB)
    }

    /// The extra providers that are on and worth asking, in `Provider::ALL` order.
    fn asked_extras(&self) -> impl Iterator<Item = &Arc<Extra>> {
        self.extras.values().filter(|e| self.asks(e.provider()))
    }
}

/// One provider's answers about episodes, as values to store (each episode also `LISTED`, so
/// one with no details yet still counts).
fn episode_values(provider: Provider, eps: &[ShownEpisode]) -> Vec<ProviderValue> {
    let mut out = Vec::new();
    for e in eps {
        let value = |field: &str, value: &str| ProviderValue {
            provider: provider.id().into(),
            season: e.season,
            episode: e.episode,
            field: field.into(),
            value: value.into(),
        };
        out.push(value(LISTED, ""));
        for (field, v) in [(NAME, &e.name), (OVERVIEW, &e.overview), (AIR_DATE, &e.air_date)] {
            if let Some(v) = v.as_deref().filter(|v| !v.trim().is_empty()) {
                out.push(value(field, v));
            }
        }
    }
    out
}

/// Record TMDB's answer for a title: its plot and artwork (cache keys), or `LISTED` alone when
/// it has none of them, so a plot it removed clears. What's shown is picked by [`apply`].
pub(crate) async fn record_tmdb_title(
    state: &AppState,
    metadata_id: i64,
    meta: &NewMetadata,
) -> anyhow::Result<()> {
    let mut values = vec![(LISTED.to_string(), String::new())];
    for (field, value) in [(OVERVIEW, &meta.overview), (POSTER, &meta.poster), (BACKDROP, &meta.backdrop)] {
        values.extend(value.as_ref().map(|v| (field.to_string(), v.clone())));
    }
    state.db.replace_title_values(metadata_id, Provider::Tmdb.id(), &values).await?;
    Ok(())
}

/// Record TMDB's episodes (only for the seasons it answered: a failed season keeps what's
/// stored), and have the episode providers asked about the show again soon (it may have new
/// episodes).
pub(crate) async fn record_tmdb_episodes(
    state: &AppState,
    metadata_id: i64,
    episodes: &[NewEpisode],
) -> anyhow::Result<()> {
    let seasons: BTreeSet<i64> = episodes.iter().map(|e| e.season).collect();
    let text: Vec<ShownEpisode> = episodes.iter().map(ShownEpisode::from).collect();
    let values = episode_values(Provider::Tmdb, &text);
    state.db.replace_episode_values(metadata_id, Provider::Tmdb.id(), &seasons, &values).await?;
    // Only when TMDB answered: a failed lookup mustn't skip an episode provider's retry wait.
    if !episodes.is_empty() {
        for p in Provider::extras().filter(|p| p.supplies(Field::Episodes)) {
            state.db.forget_provider_fetch(metadata_id, p.id()).await?;
        }
    }
    Ok(())
}

/// Pick the shown text of every episode of `seasons` that a provider allowed to list episodes
/// (`uses(p, NEW_EPISODES)`) knows. `uses(p, field)` says which of a provider's answers count.
pub(crate) fn pick_episodes(
    order: &[Provider],
    uses: impl Fn(Provider, &str) -> bool,
    values: &[ProviderValue],
    seasons: &BTreeSet<i64>,
) -> Vec<ShownEpisode> {
    let mut by_episode: BTreeMap<(i64, i64), Vec<&ProviderValue>> = BTreeMap::new();
    for v in values.iter().filter(|v| !v.is_title() && seasons.contains(&v.season)) {
        if Provider::from_id(&v.provider).is_some_and(|p| uses(p, &v.field)) {
            by_episode.entry((v.season, v.episode)).or_default().push(v);
        }
    }
    by_episode
        .into_iter()
        .filter(|(_, said)| {
            said.iter().any(|v| Provider::from_id(&v.provider).is_some_and(|p| uses(p, NEW_EPISODES)))
        })
        .map(|((season, episode), said)| {
            let get = |field: &'static str| {
                let said = &said;
                move |p: Provider| {
                    said.iter().find(|v| v.provider == p.id() && v.field == field).map(|v| v.value.as_str())
                }
            };
            ShownEpisode {
                season,
                episode,
                name: pick(order, get(NAME), |p, n| p.real_name(n, episode)).map(Into::into),
                overview: pick(order, get(OVERVIEW), |_, _| true).map(Into::into),
                air_date: pick(order, get(AIR_DATE), |_, _| true).map(Into::into),
            }
        })
        .collect()
}

/// Re-pick a title's shown plot and its episodes' text (for `seasons`, or every season with
/// files; an empty set for movies). Returns the shown episodes.
pub(crate) async fn apply(
    state: &AppState,
    metadata_id: i64,
    seasons: Option<&BTreeSet<i64>>,
) -> anyhow::Result<Vec<ShownEpisode>> {
    let values = state.db.provider_values(metadata_id).await?;
    let seasons = match seasons {
        Some(s) => s.clone(),
        None => state.db.metadata_seasons(metadata_id).await?.into_iter().collect(),
    };
    apply_values(state, &state.integrations(), metadata_id, &values, &seasons).await
}

/// Pick and write what's shown for one title from its stored answers.
async fn apply_values(
    state: &AppState,
    i: &Integrations,
    metadata_id: i64,
    values: &[ProviderValue],
    seasons: &BTreeSet<i64>,
) -> anyhow::Result<Vec<ShownEpisode>> {
    // The plot and artwork, once any provider has answered about the title (none of them having
    // one clears it); never asked, they're left as they are.
    if values.iter().any(ProviderValue::is_title) {
        let shown = pick(i.order.get(Field::Overview), title_said(i, values, OVERVIEW), |_, _| true);
        state.db.set_shown_overview(metadata_id, shown).await?;
        for (field, kind, art) in
            [(POSTER, Field::Posters, Artwork::Poster), (BACKDROP, Field::Backdrops, Artwork::Backdrop)]
        {
            let shown = pick(i.order.get(kind), title_said(i, values, field), |_, _| true);
            state.db.set_shown_artwork(metadata_id, art, shown).await?;
        }
    }
    if seasons.is_empty() {
        return Ok(Vec::new());
    }
    let shown = pick_episodes(i.order.get(Field::Episodes), |p, f| i.uses(p, f), values, seasons);
    state.db.set_shown_episodes(metadata_id, seasons, &shown).await?;
    Ok(shown)
}

/// What each provider in use said about a title's `field` (for [`pick`]).
fn title_said<'a>(
    i: &'a Integrations,
    values: &'a [ProviderValue],
    field: &'a str,
) -> impl Fn(Provider) -> Option<&'a str> {
    move |p: Provider| {
        values
            .iter()
            .find(|v| v.is_title() && v.field == field && v.provider == p.id())
            .filter(|_| i.uses(p, field))
            .map(|v| v.value.as_str())
    }
}

/// Logos (cache keys) the extra providers (Fanart.tv) have for these titles, by TMDB id:
/// `before` from providers ordered ahead of TMDB (they win), `after` from the rest (they fill
/// in where TMDB has none). One query per provider, no downloads: they're cached at lookup.
#[derive(Default)]
pub(crate) struct ExtraLogos {
    pub before: HashMap<i64, String>,
    pub after: HashMap<i64, String>,
}

pub(crate) async fn extra_logos(state: &AppState, kind: MetadataKind, tmdb_ids: &[i64]) -> ExtraLogos {
    let i = state.integrations();
    let mut out = ExtraLogos::default();
    let mut before_tmdb = true;
    for &p in i.order.get(Field::Logos) {
        if p.is_base() {
            before_tmdb = false;
            continue;
        }
        if !i.uses(p, LOGO) {
            continue;
        }
        let found = state.db.title_field_values(kind, tmdb_ids, p.id(), LOGO).await.unwrap_or_default();
        let into = if before_tmdb { &mut out.before } else { &mut out.after };
        for (id, key) in found {
            into.entry(id).or_insert(key);
        }
    }
    out
}

/// Re-pick every title (after the order changed or a provider was turned on or off). Every
/// stored answer and every title's seasons are read in two queries, not per title.
async fn apply_all(state: &AppState) {
    let (values, seasons) =
        match tokio::try_join!(state.db.all_provider_values(), state.db.all_metadata_seasons()) {
            Ok(both) => both,
            Err(e) => return tracing::warn!(error = %e, "reading stored answers to re-pick failed"),
        };
    let mut by_title: BTreeMap<i64, Vec<ProviderValue>> = BTreeMap::new();
    for (id, v) in values {
        by_title.entry(id).or_default().push(v);
    }
    let mut seasons_of: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    for (id, season) in seasons {
        seasons_of.entry(id).or_default().insert(season);
    }
    let i = state.integrations();
    let none = BTreeSet::new();
    for (id, values) in &by_title {
        let seasons = seasons_of.get(id).unwrap_or(&none);
        if let Err(e) = apply_values(state, &i, *id, values, seasons).await {
            tracing::warn!(metadata_id = id, error = %e, "re-picking metadata failed");
        }
    }
    tracing::info!(titles = by_title.len(), "metadata re-picked with the current provider settings");
}

static REPICK_RUNNING: AtomicBool = AtomicBool::new(false);
static REPICK_AGAIN: AtomicBool = AtomicBool::new(false);

/// After a provider setting changed: re-pick every title, then ask newly enabled providers about
/// the first titles, in the background. Changes made while that runs are coalesced into one
/// more run, so quick clicks never stack up runs (or OMDb requests).
pub(crate) fn repick(state: &AppState) {
    REPICK_AGAIN.store(true, Ordering::SeqCst);
    if REPICK_RUNNING.swap(true, Ordering::SeqCst) {
        return; // The running one goes again when it's done.
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            while REPICK_AGAIN.swap(false, Ordering::SeqCst) {
                apply_all(&state).await;
                refresh(&state).await;
            }
            REPICK_RUNNING.store(false, Ordering::SeqCst);
            // A change that landed between the last check and letting go: take it.
            if !REPICK_AGAIN.load(Ordering::SeqCst) || REPICK_RUNNING.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

/// An extra provider that's set up: its client, and how it's asked. This is the one place in
/// the server a provider's own code lives; everything else goes by its `Spec`.
#[derive(Debug)]
pub(crate) enum Extra {
    Tvmaze(TvMaze),
    Omdb(Omdb),
    Fanart(Fanart),
}

impl Extra {
    /// The client for `p`, with the admin's key for a provider that needs one (`None` without).
    pub(crate) fn new(p: Provider, key: Option<&str>) -> Option<Self> {
        match p {
            Provider::Tmdb => None,
            Provider::Tvmaze => Some(Extra::Tvmaze(TvMaze::new())),
            Provider::Omdb => key.map(|k| Extra::Omdb(Omdb::new(k))),
            Provider::Fanart => key.map(|k| Extra::Fanart(Fanart::new(k))),
        }
    }

    pub(crate) fn provider(&self) -> Provider {
        match self {
            Extra::Tvmaze(_) => Provider::Tvmaze,
            Extra::Omdb(_) => Provider::Omdb,
            Extra::Fanart(_) => Provider::Fanart,
        }
    }

    /// Check an admin's key with the provider before it's saved: `Err` with what to tell them.
    pub(crate) async fn check_key(p: Provider, key: &str) -> Result<(), crate::error::ApiError> {
        use crate::error::ApiError;
        match p {
            Provider::Omdb => match Omdb::new(key).by_imdb("tt0113277").await {
                // A key at its daily limit is still a good key.
                Ok(_) | Err(panda_metadata::Error::RateLimited) => Ok(()),
                Err(e) if e.is_unauthorized() => {
                    Err(ApiError::Validation("OMDb rejected this key (is it activated?)".into()))
                }
                Err(other) => Err(ApiError::Metadata(other)),
            },
            // The Matrix: every key that works finds it.
            Provider::Fanart => match Fanart::new(key).movie(603).await {
                Ok(_) => Ok(()),
                Err(e) if e.is_unauthorized() => {
                    Err(ApiError::Validation("Fanart.tv rejected this key".into()))
                }
                Err(other) => Err(ApiError::Metadata(other)),
            },
            Provider::Tmdb | Provider::Tvmaze => Ok(()),
        }
    }

    /// Ask about one title (due in `refresh`) and store the answers.
    async fn fetch(&self, state: &AppState, tmdb: &Tmdb, t: &StaleTitle) -> anyhow::Result<()> {
        match self {
            Extra::Tvmaze(c) => fetch_tvmaze(state, tmdb, c, t).await,
            Extra::Omdb(c) => fetch_omdb(state, tmdb, c, t).await,
            Extra::Fanart(c) => fetch_fanart(state, tmdb, c, t).await,
        }
    }
}

/// A title's ids elsewhere: stored at matching, else (or when the one `needed` is missing:
/// TMDB may have added it since) asked of TMDB and stored.
async fn title_ids(
    state: &AppState,
    tmdb: &Tmdb,
    t: &StaleTitle,
    needed: impl Fn(&ExternalIds) -> bool,
) -> anyhow::Result<ExternalIds> {
    let stored = ExternalIds { imdb_id: t.imdb_id.clone(), tvdb_id: t.tvdb_id };
    if needed(&stored) {
        return Ok(stored);
    }
    let ids = tmdb.external_ids(t.kind == MetadataKind::Series, t.tmdb_id).await?;
    state.db.set_title_ids(t.metadata_id, ids.imdb_id.as_deref(), ids.tvdb_id).await?;
    Ok(ids)
}

/// A show's seasons with files, minus seasons taken from another TMDB show (an anthology's
/// story): other providers' answers about those would be about the show's own season. None at
/// all for a show numbered by another of TMDB's episode orders (DVD, absolute): the episode
/// providers number by the default one.
async fn own_seasons(state: &AppState, metadata_id: i64) -> anyhow::Result<BTreeSet<i64>> {
    let mut seasons: BTreeSet<i64> = state.db.metadata_seasons(metadata_id).await?.into_iter().collect();
    for folder in state.db.metadata_folders(metadata_id).await? {
        let folder = matching::normalize(&folder);
        if state.db.episode_order(&folder).await?.is_some() {
            return Ok(BTreeSet::new());
        }
        for m in state.db.season_matches(&folder).await? {
            seasons.remove(&m.season);
        }
    }
    Ok(seasons)
}

/// Ask TVmaze about a show's episodes in its own seasons (none taken from another show). It
/// counts as asked even when TVmaze doesn't have the show, so it's asked again next month (or
/// when it gets new episodes).
async fn fetch_tvmaze(state: &AppState, tmdb: &Tmdb, tvmaze: &TvMaze, t: &StaleTitle) -> anyhow::Result<()> {
    let own = own_seasons(state, t.metadata_id).await?;
    if !own.is_empty() {
        // TVmaze finds a show by its TVDB id, else its IMDb id.
        let ids = title_ids(state, tmdb, t, |i| i.tvdb_id.is_some() || i.imdb_id.is_some()).await?;
        let episodes = match tvmaze.find(&ids).await? {
            Some(show) => tvmaze.episodes(show).await?,
            None => Vec::new(),
        };
        let text: Vec<ShownEpisode> = episodes
            .into_iter()
            .map(|e| ShownEpisode {
                season: e.season,
                episode: e.episode,
                name: e.name,
                overview: e.overview,
                air_date: e.air_date,
            })
            .collect();
        let values = episode_values(Provider::Tvmaze, &text);
        state.db.replace_episode_values(t.metadata_id, Provider::Tvmaze.id(), &own, &values).await?;
    }
    // A scan may have linked a new season's files meanwhile: then it's asked again next pass
    // rather than skipped for a month.
    if own_seasons(state, t.metadata_id).await? == own {
        state.db.record_provider_fetch(t.metadata_id, Provider::Tvmaze.id(), now()).await?;
    }
    Ok(())
}

/// Ask OMDb about a title (by its `IMDb` id): its plot and ratings.
async fn fetch_omdb(state: &AppState, tmdb: &Tmdb, omdb: &Omdb, t: &StaleTitle) -> anyhow::Result<()> {
    let ids = title_ids(state, tmdb, t, |i| i.imdb_id.is_some()).await?;
    let mut values = Vec::new();
    if let Some(imdb) = ids.imdb_id.as_deref()
        && let Some(found) = omdb.by_imdb(imdb).await?
    {
        values.extend(found.plot.map(|p| (OVERVIEW.to_string(), p)));
        values.extend(found.ratings.into_iter().map(|r| (rating_field(r.source), r.value)));
    }
    state.db.replace_title_values(t.metadata_id, Provider::Omdb.id(), &values).await?;
    state.db.record_provider_fetch(t.metadata_id, Provider::Omdb.id(), now()).await?;
    Ok(())
}

/// Ask Fanart.tv about a title's artwork (movies by TMDB id, shows by TVDB id).
async fn fetch_fanart(state: &AppState, tmdb: &Tmdb, fanart: &Fanart, t: &StaleTitle) -> anyhow::Result<()> {
    let art = if t.kind == MetadataKind::Series {
        match title_ids(state, tmdb, t, |i| i.tvdb_id.is_some()).await?.tvdb_id {
            Some(show_id) => fanart.show(show_id).await?,
            None => None,
        }
    } else {
        fanart.movie(t.tmdb_id).await?
    };
    // Downloaded (and scaled) now, in the background pass: what's stored is the cache key, so
    // picking one later, or showing a logo on Home, never waits on Fanart.tv.
    let mut values = Vec::new();
    if let Some(a) = art {
        for (field, url, size) in [
            (POSTER, a.poster, ImageSize::Poster),
            (BACKDROP, a.backdrop, ImageSize::Backdrop),
            (LOGO, a.logo, ImageSize::Logo),
        ] {
            let Some(url) = url else { continue };
            if let Some(key) = state.images.fetch_remote(size, &url).await? {
                values.push((field.to_string(), key));
            }
        }
    }
    state.db.replace_title_values(t.metadata_id, Provider::Fanart.id(), &values).await?;
    state.db.record_provider_fetch(t.metadata_id, Provider::Fanart.id(), now()).await?;
    Ok(())
}

/// Whether an error means "stop asking this provider for now" (daily limit, rejected key).
fn stops_pass(e: &anyhow::Error) -> bool {
    e.downcast_ref::<panda_metadata::Error>()
        .is_some_and(|e| matches!(e, panda_metadata::Error::RateLimited) || e.is_unauthorized())
}

/// After a failed lookup: try again in a day, behind titles never asked.
async fn record_failure(state: &AppState, metadata_id: i64, p: Provider) {
    let at = now() - REFRESH_SECS + RETRY_FAILED_SECS;
    if let Err(e) = state.db.record_provider_fetch(metadata_id, p.id(), at).await {
        tracing::warn!(error = %e, "recording a failed lookup failed");
    }
}

/// [`refresh`] in the background (after a metadata pass or a match fixed by hand).
pub(crate) fn refresh_soon(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move { refresh(&state).await });
}

/// Ask the enabled extra providers about titles they haven't been asked about lately (newly
/// matched ones, and shows with new episodes, first): `per_pass` titles each, `concurrency` at
/// a time.
pub(crate) async fn refresh(state: &AppState) {
    let _one_at_a_time = REFRESH.lock().await;
    let i = state.integrations();
    let Some(tmdb) = i.tmdb.clone() else { return };
    let before = now() - REFRESH_SECS;
    for extra in i.asked_extras() {
        let p = extra.provider();
        let Some(spec) = &p.spec().extra else { continue };
        let limit = i64::try_from(spec.per_pass).unwrap_or(i64::MAX);
        let due =
            state.db.stale_for_provider(p.id(), spec.shows_only, before, limit).await.unwrap_or_default();
        let mut asked = 0;
        'chunks: for chunk in due.chunks(spec.concurrency.max(1)) {
            let results =
                futures_util::future::join_all(chunk.iter().map(|t| extra.fetch(state, &tmdb, t))).await;
            for (t, r) in chunk.iter().zip(results) {
                match r {
                    Ok(()) => {
                        asked += 1;
                        // A failure here is ours, not the lookup's: it isn't retried as one.
                        if let Err(e) = apply(state, t.metadata_id, None).await {
                            tracing::warn!(metadata_id = t.metadata_id, error = %e, "re-picking metadata failed");
                        }
                    }
                    Err(e) if stops_pass(&e) => {
                        tracing::warn!(provider = p.name(), error = %e, "refusing requests (daily limit or key); trying again later");
                        break 'chunks;
                    }
                    Err(e) => {
                        tracing::warn!(provider = p.name(), tmdb_id = t.tmdb_id, error = %e, "lookup failed");
                        record_failure(state, t.metadata_id, p).await;
                    }
                }
            }
        }
        if asked > 0 {
            tracing::info!(provider = p.name(), titles = asked, "titles looked up");
        }
    }
}

/// A rating shown with a title: TMDB's, then those of the extra providers that are on.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Rating {
    /// `tmdb`, `imdb`, `rotten_tomatoes`, `metacritic`.
    pub source: &'static str,
    /// "Rotten Tomatoes", and "RT" where space is short.
    pub label: &'static str,
    pub short: &'static str,
    /// As the source writes it: "7.8/10", "8.3/10", "91%", "74/100".
    pub value: String,
}

/// A title's ratings, ready to show: TMDB's (`tmdb_score`, else the stored one; 0 is "no
/// votes yet", so none), then each extra provider's in its `Spec::ratings` order, minus any the
/// admin switched off.
pub(crate) async fn ratings(
    state: &AppState,
    kind: MetadataKind,
    tmdb_id: i64,
    tmdb_score: Option<f64>,
) -> Vec<Rating> {
    let mut out = Vec::new();
    let score = match tmdb_score {
        Some(s) => Some(s),
        None => state.db.title_rating(kind, tmdb_id).await.ok().flatten(),
    };
    if let (Some(score), Some(r)) = (score.filter(|s| *s > 0.0), Provider::Tmdb.spec().ratings.first()) {
        out.push(Rating {
            source: r.source,
            label: r.label,
            short: r.short,
            value: format!("{score:.1}/10"),
        });
    }
    let i = state.integrations();
    for p in i.asked_extras().map(|e| e.provider()).filter(|p| !p.spec().ratings.is_empty()) {
        let values = state.db.title_values(kind, tmdb_id, p.id()).await.unwrap_or_default();
        for r in p.spec().ratings {
            let field = rating_field(r.source);
            if !i.uses(p, &field) {
                continue;
            }
            if let Some((_, value)) = values.iter().find(|(f, _)| *f == field) {
                out.push(Rating { source: r.source, label: r.label, short: r.short, value: value.clone() });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(provider: Provider, season: i64, episode: i64, field: &str, value: &str) -> ProviderValue {
        ProviderValue {
            provider: provider.id().into(),
            season,
            episode,
            field: field.into(),
            value: value.into(),
        }
    }

    #[test]
    fn tmdbs_answers_count_even_without_its_token() {
        let i = Integrations::default();
        assert!(i.uses(Provider::Tmdb, OVERVIEW), "removing the token mustn't wipe what's shown");
        assert!(!i.uses(Provider::Omdb, OVERVIEW), "a provider that's off doesn't count");
        assert!(!i.asks(Provider::Tmdb) && !i.asks(Provider::Omdb));
    }

    #[test]
    fn an_episode_with_no_details_still_counts_as_listed() {
        let bare = ShownEpisode { season: 3, episode: 10, name: None, overview: None, air_date: None };
        let values = episode_values(Provider::Tmdb, &[bare]);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].field, LISTED);
        let shown = pick_episodes(&[Provider::Tmdb], |_, _| true, &values, &BTreeSet::from([3]));
        assert_eq!(shown.len(), 1, "it stays (and isn't dropped and re-added every scan)");
        assert_eq!(shown[0].name, None);
    }

    #[test]
    fn episodes_follow_the_order_and_skip_stand_ins() {
        use Provider::{Tmdb, Tvmaze};
        let values = vec![
            v(Tmdb, 1, 1, "name", "Pilot"),
            v(Tmdb, 1, 1, "overview", "TMDB plot."),
            v(Tvmaze, 1, 1, "name", "Pilot (TVmaze)"),
            v(Tvmaze, 1, 1, "air_date", "2008-01-20"),
            v(Tmdb, 1, 2, "name", "Episode 2"),
            v(Tvmaze, 1, 2, "name", "Cat's in the Bag"),
            v(Tvmaze, 1, 3, "name", "Only TVmaze"),
            v(Tvmaze, 2, 1, "name", "Not on disk"),
        ];
        let seasons = BTreeSet::from([1]);
        let all = |_: Provider, _: &str| true;
        let tmdb_first = pick_episodes(&[Tmdb, Tvmaze], all, &values, &seasons);
        assert_eq!(tmdb_first.len(), 3, "season 2 has no files");
        assert_eq!(tmdb_first[0].name.as_deref(), Some("Pilot"));
        assert_eq!(tmdb_first[0].overview.as_deref(), Some("TMDB plot."));
        assert_eq!(tmdb_first[0].air_date.as_deref(), Some("2008-01-20"), "a gap is filled");
        assert_eq!(tmdb_first[1].name.as_deref(), Some("Cat's in the Bag"), "stand-ins lose");
        assert_eq!(tmdb_first[2].name.as_deref(), Some("Only TVmaze"));

        let tvmaze_first = pick_episodes(&[Tvmaze, Tmdb], all, &values, &seasons);
        assert_eq!(tvmaze_first[0].name.as_deref(), Some("Pilot (TVmaze)"));

        let tvmaze_off = pick_episodes(&[Tvmaze, Tmdb], |p, _| p == Tmdb, &values, &seasons);
        assert_eq!(tvmaze_off.len(), 2, "episodes only TVmaze knows go with it");
        assert_eq!(tvmaze_off[1].name.as_deref(), Some("Episode 2"), "a stand-in beats nothing");
        assert_eq!(tvmaze_off[0].air_date, None);

        // TVmaze on, but only for air dates: no names from it, no episodes only it lists.
        let dates_only = |p: Provider, f: &str| p == Tmdb || f == "air_date";
        let shown = pick_episodes(&[Tvmaze, Tmdb], dates_only, &values, &seasons);
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[0].name.as_deref(), Some("Pilot"));
        assert_eq!(shown[0].air_date.as_deref(), Some("2008-01-20"));
        assert_eq!(shown[1].name.as_deref(), Some("Episode 2"));
    }
}
