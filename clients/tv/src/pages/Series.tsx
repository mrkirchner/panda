import { useBackdropPreview } from "../playback/preview";
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { api, ensureSession, imageUrl } from "../api/client";
import type { Discover, Item, SeriesSummary } from "../api/types";
import { Backdrop } from "../components/Backdrop";
import { PillButton } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { TopBar } from "../components/TopBar";
import { focusTopBar, useNavigate } from "../nav";
import { CardRow, GhostRow } from "../components/CardRow";
import { displayText, longDate, tmdbRating } from "../format";
import { EpisodesSection, type EpisodeEntry } from "../components/EpisodesSection";
import { InfoSection, type About } from "../components/InfoSection";
import { TextSheet } from "../components/TextSheet";
import type { MetaPart } from "../components/MetaLine";
import { HEADER_H, HeaderArea, PageRows } from "../components/PageRows";
import { PeopleRow } from "../components/PeopleRow";
import { SeasonPicker } from "../components/SeasonPicker";
import { createDiscoverStatus } from "../discoverStatus";
import { TitleHeader } from "../components/TitleHeader";
import { createMyListToggle } from "../myList";
import { theme } from "../theme";
import { t, tn } from "../i18n";

const { screen, color, font } = theme;
/** The movie page's layout: full backdrop with the title block low on it, tabs peeking in;
 * Down scrolls the tabs and their content up. */
const BUTTONS_Y = HEADER_H - 170;

/** A More Like This entry: one of your shows, or one you could request. */
interface MoreItem {
  show?: SeriesSummary;
  suggestion?: Discover;
}

const order = (e: Item) => [e.season === 0 ? 9999 : (e.season ?? 0), e.episode ?? 0] as const;
const byOrder = (a: Item, b: Item) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1];

/**
 * A show: details and Play at the top, then tabs. Episodes: seasons listed on the left, that
 * season's episodes (virtualized) with their details on the right. Similar: shows like this one.
 * Details: everything else.
 */
/** How long a season must stay selected before the page shows its story. */
const STORY_SETTLE_MS = 700;

function SeriesView() {
  const params = useParams();
  const navigate = useNavigate();
  const name = () => decodeURIComponent(params.name ?? "");
  const myList = createMyListToggle("series", name);
  let buttonsRef: ElementNode | undefined;

  const [data] = createResource(name, async series => {
    await ensureSession();
    const [all, episodes] = await Promise.all([
      api.series(),
      api.items({ series, kind: "episode", limit: 10000 }),
    ]);
    return { summary: all.find(s => s.series === series), episodes: [...episodes].sort(byOrder) };
  });
  const [similar] = createResource(name, n => api.relatedSeries(n).catch(() => [] as SeriesSummary[]));
  const [suggestions] = createResource(name, n => api.seriesSuggestions(n).catch(() => [] as Discover[]));
  const [details] = createResource(name, n => api.seriesDetails(n).catch(() => undefined));
  /** Your shows first, then ones you could request. */
  const more = createMemo<MoreItem[]>(() => [
    // A show in two libraries (e.g. HD and 4K folders) appears once.
    ...(similar() ?? [])
      .filter((x, i, all) => !x.tmdb_id || all.findIndex(y => y.tmdb_id === x.tmdb_id) === i)
      .map(show => ({ show })),
    ...(suggestions() ?? []).map(suggestion => ({ suggestion })),
  ]);
  const status = createDiscoverStatus();
  // "More seasons": the seasons TMDB lists that aren't in your library (needs Sonarr).
  const [features] = createResource(() => api.features().catch(() => null));
  const missing = createMemo(() => {
    const total = details()?.seasons ?? 0;
    const have = new Set((data()?.episodes ?? []).map(e => e.season ?? 0));
    return Array.from({ length: total }, (_, i) => i + 1).filter(n => !have.has(n));
  });
  const [picking, setPicking] = createSignal(false);
  /** The About card opened in full. */
  const [expanded, setExpanded] = createSignal<About | null>(null);
  const [moreNote, setMoreNote] = createSignal("");
  const getSeasons = async (picked: number[] | null) => {
    setPicking(false);
    const seasons = picked ?? missing();
    try {
      await api.moreSeasons(name(), seasons);
      setMoreNote(
        seasons.length === 1
          ? t("Requested season {n}.", { n: seasons[0]! })
          : tn(seasons.length, "Requested {n} season.", "Requested {n} seasons."),
      );
    } catch (e) {
      setMoreNote((e as Error).message);
    }
    buttonsRef?.setFocus();
  };
  const [onHeader, setOnHeader] = createSignal(true);
  // The show's preview clip behind the header after a moment there (stops on scrolling down).
  const video = useBackdropPreview(() => (name() ? { kind: "series", name: name() } : null), onHeader);

  const seasons = createMemo(() => {
    const groups = new Map<number, Item[]>();
    for (const e of data()?.episodes ?? []) {
      const s = e.season ?? 0;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s)!.push(e);
    }
    return [...groups.entries()].map(([season, eps]) => ({
      title: season === 0 ? "Specials" : `Season ${season}`,
      eps,
    }));
  });
  const [season, setSeason] = createSignal(0);
  /** The season the page is about (an anthology's story: backdrop, cast, facts). It follows the
   *  focused season tab once you rest on it (STORY_SETTLE_MS, so arrowing across tabs doesn't
   *  load each story), or at once when you leave the tabs. */
  const [settled, setSettled] = createSignal(0);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(settleTimer));
  const pickSeason = (i: number) => {
    setSeason(i);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => setSettled(i), STORY_SETTLE_MS);
  };
  /** Leaving the season tabs: the season you're on is the page's at once (no waiting). */
  const leaveSeasons = () => {
    clearTimeout(settleTimer);
    setSettled(season());
  };
  const storySeason = () => seasons()[settled()]?.eps[0]?.season;
  /** That season's story when it's another TMDB show (an anthology): its own description,
   *  backdrop, cast and facts. */
  const seasonArt = createMemo(() => {
    const s = storySeason();
    return details()?.season_art?.find(a => a.season === s);
  });
  const [storyDetails] = createResource(
    () => {
      const art = seasonArt();
      return art ? { name: name(), season: art.season } : false;
    },
    k => api.seriesDetails(k.name, k.season).catch(() => undefined),
  );
  /** What the Cast and Details tabs show: the selected story's, else the show's. */
  const shownDetails = () => (seasonArt() ? (storyDetails() ?? details()) : details());
  const people = createMemo(() => [...(shownDetails()?.directors ?? []), ...(shownDetails()?.cast ?? [])]);
  /**
   * The scores shown with the selected season: a story's own (from its details), else the
   * show's. The show's TMDB score is only the fallback for the show itself, never a story's.
   */
  const shownRating = () => (seasonArt() ? null : summary()?.rating);
  const shownRatings = () => (seasonArt() ? storyDetails() : details())?.ratings;
  const seasonBackdrop = () => seasonArt()?.backdrop ?? undefined;

  /** Where "Play" goes: the episode in progress, else the first one not finished. */
  const next = createMemo(() => {
    const eps = (data()?.episodes ?? []).filter(e => e.season !== 0);
    const inProgress = eps
      .filter(e => e.progress && !e.progress.finished && e.progress.position_secs > 0)
      .sort((a, b) => (b.progress?.last_played_at ?? 0) - (a.progress?.last_played_at ?? 0))[0];
    return inProgress ?? eps.find(e => !e.progress?.finished) ?? eps[0];
  });
  // Open on the season you're up to.
  createEffect(
    on(next, e => {
      const i = e ? seasons().findIndex(s => s.eps.includes(e)) : -1;
      if (i >= 0) {
        setSeason(i);
        setSettled(i);
      }
    }),
  );
  const nextLabel = () => {
    const e = next();
    if (!e) return "Play";
    // Extras can lack an episode number: just the season then.
    const se = e.episode == null ? `S${e.season ?? 0}` : `S${e.season ?? 0} E${e.episode}`;
    return e.progress && !e.progress.finished && e.progress.position_secs > 0 ? `Resume ${se}` : `Play ${se}`;
  };
  const playEpisode = (e: Item) => {
    const at = e.progress && !e.progress.finished ? e.progress.position_secs : 0;
    navigate(`/play/item/${e.id}?start=${at}`);
  };

  const summary = () => data()?.summary;
  const totals = () => {
    const eps = data()?.episodes.length ?? 0;
    const watched = data()?.episodes.filter(e => e.progress?.finished).length ?? 0;
    return [
      tn(seasons().length, "{n} season", "{n} seasons"),
      t("{n} episodes", { n: eps }),
      t("{n} watched", { n: watched }),
    ].join(" · ");
  };

  /** The next episode still to air (TMDB), when you don't have it yet. */
  const upcoming = () => {
    const n = details()?.next_episode;
    if (!n) return null;
    const have = (data()?.episodes ?? []).some(e => e.season === n.season && e.episode === n.episode);
    return have ? null : n;
  };
  /** Seasons as the episodes row shows them: your episodes, then the next one still to air. */
  const seasonEntries = createMemo(() =>
    seasons().map(s => {
      const number = s.eps[0]?.season;
      const up = upcoming();
      const entries: EpisodeEntry[] = s.eps.map(item => ({ item }));
      if (up && up.season === number) {
        entries.push({
          upcoming: {
            season: up.season,
            episode: up.episode,
            name: up.name,
            overview: up.overview,
            airDate: up.air_date,
          },
        });
      }
      return { title: s.title, entries };
    }),
  );
  /** "2020 · 4 seasons · TV-MA", then the ratings (their own line), and the next episode's date
   * when it's in a season you don't have yet. */
  const metaParts = (): MetaPart[] => {
    const sm = summary();
    if (!sm) return [];
    const up = upcoming();
    const laterSeason = up && !seasons().some(s => s.eps[0]?.season === up.season);
    const ratings = shownRatings()?.length ? shownRatings()! : tmdbRating(shownRating());
    return [
      (seasonArt()?.year ?? sm.year)?.toString() ?? "",
      tn(seasons().length, "{n} season", "{n} seasons"),
      shownDetails()?.certification ?? "",
      laterSeason
        ? t("Next: S{s} E{e}, {date}", {
            s: up.season,
            e: up.episode,
            date: longDate(up.air_date) ?? t("soon"),
          })
        : "",
      ...ratings.slice(0, 3).map(rating => ({ rating })),
    ];
  };
  /** Under the title: what's next ("S4, E10 · Being Alive: ..."), else the show's story. */
  const overview = () => {
    if (seasonArt()) return seasonArt()!.overview;
    const e = next();
    const started = (data()?.episodes ?? []).some(x => x.progress);
    if (e && started && e.episode != null && e.episode_title) {
      const plot = e.episode_overview ? `: ${e.episode_overview}` : "";
      return `S${e.season ?? 0}, E${e.episode} · ${e.episode_title}${plot}`;
    }
    return summary()?.overview;
  };
  /** On the episodes (seasons and their cards). */
  const [onEpisodes, setOnEpisodes] = createSignal(false);
  /** An anthology season's facts: its year, rating and scores, beside the tabs. */
  const storyParts = (): MetaPart[] => {
    const art = seasonArt();
    if (!art) return [];
    const d = storyDetails();
    return [
      art.year?.toString() ?? "",
      d?.certification ?? "",
      ...(d?.ratings ?? []).slice(0, 3).map(rating => ({ rating })),
    ];
  };
  const credits = () => {
    const d = shownDetails();
    if (!d) return [];
    return [
      {
        label: t("Starring"),
        names: d.cast
          .slice(0, 3)
          .map(p => p.name)
          .join(", "),
      },
      { label: t("Created by"), names: d.directors.map(p => p.name).join(", ") },
    ].filter(c => c.names);
  };

  return (
    <View>
      <Backdrop
        src={imageUrl(seasonBackdrop() ?? summary()?.backdrop)}
        // Not dimmed on the episodes either: an anthology's season shows its own backdrop there.
        dim={!onHeader() && !onEpisodes()}
        video={video()}
      />
      <PageRows onHeaderFocused={setOnHeader} onTopUp={focusTopBar}>
        <HeaderArea visible={onHeader()}>
          <TitleHeader
            ref={el => (buttonsRef = el)}
            title={seasonArt()?.title ?? summary()?.meta_title ?? name()}
            metaParts={metaParts()}
            logo={seasonArt() ? undefined : (imageUrl(details()?.logo) ?? null)}
            credits={credits()}
            overview={overview()}
            buttonsY={BUTTONS_Y}
            autofocus
          >
            <PillButton
              primary
              label={nextLabel()}
              width={300}
              onSelect={() => next() && playEpisode(next()!)}
            />
            <IconButton
              icon={myList.inList() ? "check" : "plus"}
              size={64}
              label={myList.inList() ? t("In My List") : t("Add to My List")}
              onSelect={() => void myList.toggle()}
            />
            <Show when={features()?.request_shows && missing().length > 0}>
              <PillButton
                label={t("More seasons")}
                width={260}
                onSelect={() => (missing().length === 1 ? void getSeasons(null) : setPicking(true))}
              />
            </Show>
          </TitleHeader>
          <Text
            x={screen.gutter}
            y={BUTTONS_Y + 84}
            fontSize={font.caption}
            color={color.textMuted}
            alpha={moreNote() ? 1 : 0}
          >
            {displayText(moreNote()) || " "}
          </Text>
          {/* Avatar, search and the clock (no tabs on a show page); Up from the buttons. */}
          <TopBar visible={onHeader()} onDown={() => (buttonsRef?.setFocus(), true)} />
        </HeaderArea>

        {/* One page, scrolled down: episodes, similar shows, the people, the facts. */}
        <Show when={seasonEntries().length > 0}>
          <EpisodesSection
            story={
              seasonArt()
                ? {
                    title: seasonArt()!.title,
                    parts: storyParts(),
                    overview: seasonArt()!.overview,
                  }
                : undefined
            }
            onFocused={setOnEpisodes}
            seasons={seasonEntries()}
            season={season()}
            onSeason={pickSeason}
            onLeaveSeasons={leaveSeasons}
            thumb={e => imageUrl(e.item?.episode_still ?? seasonBackdrop() ?? summary()?.backdrop)}
            onPlay={playEpisode}
          />
        </Show>
        <Show when={!similar.loading && !suggestions.loading} fallback={<GhostRow />}>
          <Show when={more().length > 0}>
            <CardRow<MoreItem>
              title={t("More Like This")}
              items={more()}
              card={m =>
                m.show
                  ? {
                      width: 0,
                      height: 0,
                      image: imageUrl(m.show.poster),
                      title: m.show.meta_title ?? m.show.series,
                      onSelect: () => navigate(`/series/${encodeURIComponent(m.show!.series)}`),
                    }
                  : {
                      width: 0,
                      height: 0,
                      image: imageUrl(m.suggestion!.poster),
                      title: m.suggestion!.title,
                      badge: status(m.suggestion!).label,
                      badgeTone: status(m.suggestion!).tone,
                      progress: status(m.suggestion!).progress,
                      onSelect: () => navigate(`/discover/series/${m.suggestion!.tmdb_id}`),
                    }
              }
            />
          </Show>
        </Show>
        <Show when={people().length > 0}>
          <PeopleRow title={t("Cast & Crew")} people={people()} />
        </Show>
        <Show when={summary()}>
          {sm => (
            <InfoSection
              title={seasonArt()?.title ?? sm().meta_title ?? name()}
              genres={sm().genres}
              overview={seasonArt()?.overview ?? sm().overview}
              details={shownDetails()}
              information={[
                { label: t("Network"), value: shownDetails()?.studios.join(", ") },
                { label: t("First aired"), value: longDate(shownDetails()?.release_date) },
                { label: t("Rated"), value: shownDetails()?.certification },
                { label: t("Status"), value: shownDetails()?.status },
                { label: t("Region of origin"), value: shownDetails()?.countries?.join(", ") },
              ]}
              files={[{ label: t("In your library"), value: displayText(totals()) }]}
              onExpand={setExpanded}
            />
          )}
        </Show>
      </PageRows>
      <Show when={expanded()}>
        {e => (
          <TextSheet
            title={e().title}
            subtitle={e().genres}
            text={e().text}
            onClose={() => {
              const back = e().refocus;
              setExpanded(null);
              back();
            }}
          />
        )}
      </Show>
      <Show when={picking()}>
        <SeasonPicker
          title={summary()?.meta_title ?? name()}
          heading={t("Get which seasons?")}
          seasons={missing()}
          onRequest={s => void getSeasons(s)}
          onCancel={() => {
            setPicking(false);
            buttonsRef?.setFocus();
          }}
        />
      </Show>
    </View>
  );
}

/**
 * Rebuilt for each show: opening another from More Like This keeps the same route, and
 * a reused page would stay scrolled down with the old tab and focus.
 */
export default function Series() {
  const params = useParams<{ name: string }>();
  return (
    <Show when={params.name} keyed>
      <SeriesView />
    </Show>
  );
}
