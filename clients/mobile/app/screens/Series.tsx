// A show, laid out like the TV's: backdrop, logo or name, facts and ratings, Play (the next
// episode), My List and More seasons; its episodes by season; More Like This, Cast & Crew, and
// Information and Languages.
import { Dialogs, Screen } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Discover, Item, SeriesSummary } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show, createMemo, createSignal } from "solid-js";
import { facts, load, longDate, runtime } from "../data";
import { features } from "../features";
import { myListToggle } from "../myList";
import { play } from "../player";
import { ClipArt, GhostRow, Logo, Progress } from "./cards";
import { pickSeasons } from "./SeasonPicker";
import { Action, Facts, MoreRow, PeopleRow, Ratings, trackList } from "./sections";

/** Episode order, Specials (season 0) last, as the TV lists them. */
export function sortEpisodes(eps: Item[]): Item[] {
  const season = (e: Item) => (e.season === 0 ? Number.MAX_SAFE_INTEGER : (e.season ?? 0));
  return [...eps].sort((a, b) => season(a) - season(b) || (a.episode ?? 0) - (b.episode ?? 0));
}

/**
 * What Play plays, as on the TV: the episode you watched last if it's unfinished, else the first
 * one not watched, else the first; never a Special unless the show has nothing else.
 */
export function nextUp(eps: Item[]): Item | undefined {
  const regular = eps.filter(e => e.season !== 0);
  const pool = regular.length ? regular : eps;
  const started = pool
    .filter(e => e.progress && !e.progress.finished && e.progress.position_secs > 30)
    .sort((a, b) => (b.progress?.last_played_at ?? 0) - (a.progress?.last_played_at ?? 0));
  return started[0] ?? pool.find(e => !e.progress?.finished) ?? pool[0];
}

/** Episodes shown at once in a season (then "Show more"). */
const EPISODES_PAGE = 40;

const label = (e: Item) => `S${e.season ?? 0}:E${e.episode ?? 0}`;

export function seriesScreen(name: string) {
  const show = load(async () => (await api.series()).find(s => s.series === name) ?? null);
  const episodes = load(async () => sortEpisodes(await api.items({ series: name, kind: "episode", limit: 10000 })), {
    live: true,
  });
  const details = load(() => api.seriesDetails(name).catch(() => null));
  const similar = load(() => api.relatedSeries(name).catch(() => [] as SeriesSummary[]));
  const suggestions = load(() => api.seriesSuggestions(name).catch(() => [] as Discover[]));
  const canRequest = load(async () => (await features())?.request_shows ?? false);
  const myList = myListToggle("series", name);

  const seasons = createMemo(() => [...new Set((episodes.value() ?? []).map(e => e.season ?? 0))]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const next = () => nextUp(episodes.value() ?? []);
  /** Any episode watched or begun. */
  const started = () => (episodes.value() ?? []).some(e => e.progress);
  const season = () => picked() ?? next()?.season ?? seasons()[0] ?? 0;
  const inSeason = () => (episodes.value() ?? []).filter(e => (e.season ?? 0) === season());
  /** Long seasons (shows numbered straight through) a page at a time, not hundreds of rows at once. */
  const [limit, setLimit] = createSignal(EPISODES_PAGE);
  const shown = () => inSeason().slice(0, limit());
  /** The seasons TMDB lists that aren't in your library (More seasons asks Sonarr for them). */
  const missing = createMemo(() => {
    const total = details.value()?.seasons ?? 0;
    const have = new Set(seasons());
    return Array.from({ length: total }, (_, i) => i + 1).filter(n => !have.has(n));
  });
  const [note, setNote] = createSignal("");

  const playEpisode = (e: Item) => {
    const p = e.progress;
    play({ kind: "item", id: e.id }, p && !p.finished ? p.position_secs : 0).catch(
      err => void Dialogs.alert(String(err instanceof Error ? err.message : err)),
    );
  };

  const moreSeasons = async () => {
    let seasonsToGet = missing();
    if (seasonsToGet.length > 1) {
      // The TV's picker: All, or any of them.
      const picked = await pickSeasons(seasonsToGet, t("More seasons"), t("Get seasons"));
      if (picked === undefined) return;
      if (picked) seasonsToGet = picked;
    }
    try {
      await api.moreSeasons(name, seasonsToGet);
      setNote(
        seasonsToGet.length === 1
          ? t("Requested season {n}.", { n: seasonsToGet[0] })
          : t("Requested {n} seasons.", { n: seasonsToGet.length }),
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  /** A season that is another TMDB show's story (an anthology): its own name, art and text. */
  const art = () => details.value()?.season_art?.find(a => a.season === season());
  /** TMDB's next episode to air, unless it's already in your library. */
  const upcoming = () => {
    const n = details.value()?.next_episode;
    if (!n) return null;
    const have = (episodes.value() ?? []).some(e => e.season === n.season && e.episode === n.episode);
    return have ? null : n;
  };
  /** Its season is in the library: a greyed card at the end of it (else said in the facts). */
  const upcomingInSeason = () => {
    const n = upcoming();
    return n && seasons().includes(n.season) ? n : null;
  };
  /** "Next: S2:E5 "The Name" airs March 3, 2024" (when its season isn't in the library). */
  const nextAiring = () => {
    const n = upcoming();
    if (!n || upcomingInSeason()) return "";
    const when = longDate(n.air_date);
    return [
      `${t("Next")}: S${n.season}:E${n.episode}${n.name ? ` "${n.name}"` : ""}`,
      when ? t("airs {date}", { date: when }) : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={show.error() || episodes.error()}>
          <label class="error form" textWrap={true} text={show.error() ?? episodes.error() ?? ""} />
        </Show>
        <ClipArt image={art()?.backdrop ?? show.value()?.backdrop} clip={{ kind: "series", name }} />
        <stacklayout class="form">
          <Show
            when={details.value()?.logo && !art()}
            fallback={<label class="h1" textWrap={true} text={art()?.title ?? show.value()?.meta_title ?? name} />}
          >
            <Logo image={details.value()!.logo} height={70} maxWidth={Screen.mainScreen.widthDIPs * 0.7} />
          </Show>
          <label
            class="facts"
            textWrap={true}
            text={facts([
              show.value()?.year,
              seasons().length ? t("{n} seasons", { n: seasons().length }) : null,
              details.value()?.certification,
              details.value()?.status,
            ])}
          />
          <Ratings
            ratings={details.value()?.ratings?.length ? details.value()!.ratings! : tmdbRating(show.value()?.rating)}
          />
          <Show when={nextAiring()}>
            <label class="status-line" textWrap={true} text={nextAiring()} />
          </Show>
          <Show when={next()}>
            <button
              class="primary"
              text={
                next()!.progress && !next()!.progress!.finished
                  ? t("Resume {episode}", { episode: label(next()!) })
                  : t("Play {episode}", { episode: label(next()!) })
              }
              on:tap={() => playEpisode(next()!)}
            />
          </Show>
          <stacklayout orientation="horizontal" class="actions">
            <Action
              icon={myList.inList() ? "checkmark" : "plus"}
              label={myList.inList() ? t("In My List") : t("My List")}
              on={myList.inList()}
              onTap={() => void myList.toggle()}
            />
            <Show when={canRequest.value() && missing().length > 0}>
              <Action icon="square.and.arrow.down" label={t("More seasons")} onTap={() => void moreSeasons()} />
            </Show>
          </stacklayout>
          <Show when={note()}>
            <label class="status-line" textWrap={true} text={note()} />
          </Show>
          {/* Once you've started the show, its next episode (as the TV shows it): "S4:E10 · Name: plot". */}
          <label
            class="overview"
            textWrap={true}
            text={
              art()?.overview ??
              (started() && next()
                ? `${label(next()!)} · ${next()!.episode_title ?? next()!.title}${next()!.episode_overview ? `: ${next()!.episode_overview}` : ""}`
                : (show.value()?.overview ?? ""))
            }
          />
          <Show when={details.value()}>
            <label
              class="credits-line"
              textWrap={true}
              text={[
                details.value()!.cast.length
                  ? `${t("Starring")}: ${details.value()!.cast.slice(0, 3).map(p => p.name).join(", ")}`
                  : "",
                details.value()!.directors.length
                  ? `${t("Created by")}: ${details.value()!.directors.map(p => p.name).join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n")}
            />
          </Show>
        </stacklayout>
        <scrollview orientation="horizontal" scrollBarIndicatorVisible={false}>
          <stacklayout orientation="horizontal" class="row-items">
            <For each={seasons()}>
              {s => (
                <label
                  class={season() === s ? "season-tab selected" : "season-tab"}
                  text={s === 0 ? t("Specials") : t("Season {n}", { n: s })}
                  on:tap={() => {
                    setPicked(s);
                    setLimit(EPISODES_PAGE);
                  }}
                />
              )}
            </For>
          </stacklayout>
        </scrollview>
        <For each={shown()}>
          {e => (
            <gridlayout class="episode" columns="auto, *" on:tap={() => playEpisode(e)}>
              <stacklayout col={0}>
                <image loadMode="async" class="still" src={imageUrl(e.episode_still ?? e.backdrop)} stretch="aspectFill" />
                <Show when={e.progress && !e.progress.finished && e.progress.fraction > 0}>
                  <Progress fraction={e.progress!.fraction} width={140} />
                </Show>
              </stacklayout>
              <stacklayout col={1} class="episode-text">
                <label class="body" textWrap={true} text={`${e.episode ?? ""}. ${e.episode_title ?? e.title}`} />
                <label
                  class="small"
                  text={facts([
                    runtime(e.duration_secs),
                    e.progress?.finished
                      ? t("Watched")
                      : e.progress && e.duration_secs
                        ? t("{t} left", { t: runtime(e.duration_secs - e.progress.position_secs) })
                        : null,
                  ])}
                />
                <label class="small" textWrap={true} maxLines={2} text={e.episode_overview ?? ""} />
              </stacklayout>
            </gridlayout>
          )}
        </For>
        <Show when={inSeason().length > limit()}>
          <button
            class="secondary browse-all"
            text={t("Show more")}
            on:tap={() => setLimit(n => n + EPISODES_PAGE)}
          />
        </Show>
        {/* The next episode to air, greyed at the end of its season (the TV's). */}
        <Show when={upcomingInSeason() && upcomingInSeason()!.season === season()}>
          <gridlayout class="episode upcoming" columns="auto, *">
            <stacklayout col={0} class="still" />
            <stacklayout col={1} class="episode-text">
              <label
                class="body"
                textWrap={true}
                text={`${upcomingInSeason()!.episode}. ${upcomingInSeason()!.name ?? t("Episode {n}", { n: upcomingInSeason()!.episode })}`}
              />
              <label
                class="small accent"
                text={
                  upcomingInSeason()!.air_date
                    ? t("Coming {date}", { date: longDate(upcomingInSeason()!.air_date) ?? "" })
                    : t("Coming soon")
                }
              />
              <label class="small" textWrap={true} maxLines={2} text={upcomingInSeason()!.overview ?? ""} />
            </stacklayout>
          </gridlayout>
        </Show>
        {/* Your shows first (one per show across libraries), then ones you could request. */}
        <Show when={!episodes.value()}>
          <GhostRow variant="wide" />
        </Show>
        <Show when={similar.value() && suggestions.value()} fallback={<GhostRow />}>
          <MoreRow
            title={t("More Like This")}
            items={[
              ...(similar.value() ?? [])
                .filter((x, i, all) => !x.tmdb_id || all.findIndex(y => y.tmdb_id === x.tmdb_id) === i)
                .map(show => ({ show })),
              ...(suggestions.value() ?? []).map(suggestion => ({ suggestion })),
            ]}
          />
        </Show>
        <PeopleRow people={[...(details.value()?.directors ?? []), ...(details.value()?.cast ?? [])]} />
        <Facts
          title={t("Information")}
          facts={[
            { label: t("Network"), value: details.value()?.studios.join(", ") },
            { label: t("First aired"), value: longDate(details.value()?.release_date) },
            { label: t("Rated"), value: details.value()?.certification },
            { label: t("Status"), value: details.value()?.status },
            { label: t("Region of origin"), value: details.value()?.countries?.join(", ") },
            {
              label: t("In your library"),
              value: episodes.value()
                ? `${t("{seasons} seasons, {episodes} episodes", { seasons: seasons().length, episodes: episodes.value()!.length })}, ${t("{n} watched", { n: episodes.value()!.filter(e => e.progress?.finished).length })}`
                : null,
            },
          ]}
        />
        <Facts
          title={t("Languages")}
          facts={[
            {
              label: t("Original language"),
              value: details.value()?.original_language
                ? trackList([{ language: details.value()!.original_language!, detail: null }])
                : null,
            },
            { label: t("Audio"), value: trackList(details.value()?.audio) },
            { label: t("Subtitles"), value: trackList(details.value()?.subtitles) },
          ]}
        />
      </stacklayout>
    </scrollview>
  );
}
