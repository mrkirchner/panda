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
import { ClipArt, Logo, Progress } from "./cards";
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
  const shown = () => (episodes.value() ?? []).filter(e => (e.season ?? 0) === season());
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
    const all = t("All missing seasons");
    const options = missing().length > 1 ? [all, ...missing().map(n => t("Season {n}", { n }))] : [];
    let seasonsToGet = missing();
    if (options.length) {
      const pick = await Dialogs.action({ title: t("More seasons"), cancelButtonText: t("Cancel"), actions: options });
      const i = options.indexOf(pick);
      if (i < 0) return;
      if (i > 0) seasonsToGet = [missing()[i - 1]];
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

  /** "S2:E5 'The Name' airs March 3, 2024". */
  const nextAiring = () => {
    const n = details.value()?.next_episode;
    if (!n) return "";
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
        <ClipArt image={show.value()?.backdrop} clip={{ kind: "series", name }} />
        <stacklayout class="form">
          <Show
            when={details.value()?.logo}
            fallback={<label class="h1" textWrap={true} text={show.value()?.meta_title ?? name} />}
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
              started() && next()
                ? `${label(next()!)} · ${next()!.episode_title ?? next()!.title}${next()!.episode_overview ? `: ${next()!.episode_overview}` : ""}`
                : (show.value()?.overview ?? "")
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
                  on:tap={() => setPicked(s)}
                />
              )}
            </For>
          </stacklayout>
        </scrollview>
        <For each={shown()}>
          {e => (
            <gridlayout class="episode" columns="auto, *" on:tap={() => playEpisode(e)}>
              <stacklayout col={0}>
                <image class="still" src={imageUrl(e.episode_still ?? e.backdrop)} stretch="aspectFill" />
                <Show when={e.progress && !e.progress.finished && e.progress.fraction > 0}>
                  <Progress fraction={e.progress!.fraction} width={140} />
                </Show>
              </stacklayout>
              <stacklayout col={1} class="episode-text">
                <label class="body" textWrap={true} text={`${e.episode ?? ""}. ${e.episode_title ?? e.title}`} />
                <label class="small" text={facts([runtime(e.duration_secs), e.progress?.finished ? t("Watched") : null])} />
                <label class="small" textWrap={true} maxLines={2} text={e.episode_overview ?? ""} />
              </stacklayout>
            </gridlayout>
          )}
        </For>
        {/* Your shows first (one per show across libraries), then ones you could request. */}
        <MoreRow
          title={t("More Like This")}
          items={[
            ...(similar.value() ?? [])
              .filter((x, i, all) => !x.tmdb_id || all.findIndex(y => y.tmdb_id === x.tmdb_id) === i)
              .map(show => ({ show })),
            ...(suggestions.value() ?? []).map(suggestion => ({ suggestion })),
          ]}
        />
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
                ? t("{seasons} seasons, {episodes} episodes", { seasons: seasons().length, episodes: episodes.value()!.length })
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
