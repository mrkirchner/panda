// A show, laid out like the TV's: the hero (backdrop and clip, logo or name, facts and ratings,
// Play or Resume the next episode, My List, More seasons, credits "Created by"), then its episodes
// (season tabs over the season's episodes; TMDB's next episode greyed at the end of its season),
// More Like This, Cast & Crew, and Information and Languages.
import { useParams } from "@solidjs/router";
import { api, imageUrl } from "@tv/api/client";
import type { Discover, Item, SeriesSummary } from "@tv/api/types";
import { longDate, tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show, createMemo, createSignal } from "solid-js";
import { DetailArt, GhostRow, Logo, Progress } from "../components/cards";
import { Icon } from "../components/icons";
import { pickSeasons } from "../components/seasons";
import { Action, Credits, Facts, MoreRow, PeopleRow, Ratings, trackList } from "../components/sections";
import { facts, load, message, runtime } from "../data";
import { features } from "../features";
import { myListToggle } from "../myList";
import { nextUp, play, sortEpisodes } from "../player/launch";

/** Episodes shown at once in a season (then "Show more"). */
const EPISODES_PAGE = 40;

const label = (e: Item) => `S${e.season ?? 0}:E${e.episode ?? 0}`;

function SeriesView(props: { name: string }) {
  const name = props.name;
  const show = load(async () => (await api.series()).find((s) => s.series === name) ?? null);
  const episodes = load(
    async () => sortEpisodes(await api.items({ series: name, kind: "episode", limit: 10000 })),
    {
      live: true,
    },
  );
  const details = load(() => api.seriesDetails(name).catch(() => null));
  const similar = load(() => api.relatedSeries(name).catch(() => [] as SeriesSummary[]));
  const suggestions = load(() => api.seriesSuggestions(name).catch(() => [] as Discover[]));
  const canRequest = load(async () => (await features())?.request_shows ?? false);
  const myList = myListToggle("series", name);

  const seasons = createMemo(() => [...new Set((episodes.value() ?? []).map((e) => e.season ?? 0))]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const next = () => nextUp(episodes.value() ?? []);
  const started = () => (episodes.value() ?? []).some((e) => e.progress);
  const season = () => picked() ?? next()?.season ?? seasons()[0] ?? 0;
  const inSeason = () => (episodes.value() ?? []).filter((e) => (e.season ?? 0) === season());
  const [limit, setLimit] = createSignal(EPISODES_PAGE);
  const shown = () => inSeason().slice(0, limit());
  /** The seasons TMDB lists that aren't in your library (More seasons asks Sonarr for them). */
  const missing = createMemo(() => {
    const total = details.value()?.seasons ?? 0;
    const have = new Set(seasons());
    return Array.from({ length: total }, (_, i) => i + 1).filter((n) => !have.has(n));
  });
  const [note, setNote] = createSignal("");

  const playEpisode = (e: Item) => {
    const p = e.progress;
    play({ kind: "item", id: e.id }, p && !p.finished ? p.position_secs : 0);
  };

  const moreSeasons = async () => {
    let get = missing();
    if (get.length > 1) {
      const chosen = await pickSeasons(get, t("More seasons"), t("Get seasons"));
      if (chosen === undefined) return;
      if (chosen) get = chosen;
    }
    try {
      await api.moreSeasons(name, get);
      setNote(
        get.length === 1
          ? t("Requested season {n}.", { n: get[0] })
          : t("Requested {n} seasons.", { n: get.length }),
      );
    } catch (e) {
      setNote(message(e));
    }
  };

  /** A season that is another TMDB show's story (an anthology): its own name, art and text. */
  const art = () => details.value()?.season_art?.find((a) => a.season === season());
  /** TMDB's next episode to air, unless it's already in your library. */
  const upcoming = () => {
    const n = details.value()?.next_episode;
    if (!n) return null;
    const have = (episodes.value() ?? []).some((e) => e.season === n.season && e.episode === n.episode);
    return have ? null : n;
  };
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
  const overview = () =>
    art()?.overview ??
    (started() && next()
      ? `${label(next()!)} · ${next()!.episode_title ?? next()!.title}${next()!.episode_overview ? `: ${next()!.episode_overview}` : ""}`
      : (show.value()?.overview ?? ""));

  return (
    <>
      <Show when={show.error() || episodes.error()}>
        <p class="empty error" style={{ "padding-top": "calc(var(--topbar-h) + 32px)" }}>
          {show.error() ?? episodes.error()}
        </p>
      </Show>
      <section class="detail-hero">
        <DetailArt image={art()?.backdrop ?? show.value()?.backdrop} clip={{ kind: "series", name }} />
        <div class="detail-body">
          <div class="detail-main">
            <Show
              when={details.value()?.logo && !art()}
              fallback={<h1 class="detail-title">{art()?.title ?? show.value()?.meta_title ?? name}</h1>}
            >
              <Logo image={details.value()!.logo} title={show.value()?.meta_title ?? name} />
            </Show>
            <span class="facts-line">
              {facts([
                show.value()?.year,
                seasons().length ? t("{n} seasons", { n: seasons().length }) : null,
                details.value()?.certification,
                details.value()?.status,
              ])}
            </span>
            <Ratings
              ratings={
                details.value()?.ratings?.length
                  ? details.value()!.ratings!
                  : tmdbRating(show.value()?.rating)
              }
            />
            <Show when={nextAiring()}>
              <span class="status-line">{nextAiring()}</span>
            </Show>
            <p class="overview clamp">{overview()}</p>
            <div class="actions">
              <Show when={next()}>
                {(e) => (
                  <button class="btn primary" onClick={() => playEpisode(e())}>
                    <Icon name="play" size={20} />
                    {e().progress && !e().progress!.finished
                      ? t("Resume {episode}", { episode: label(e()) })
                      : t("Play {episode}", { episode: label(e()) })}
                  </button>
                )}
              </Show>
              <Action
                icon={myList.inList() ? "check" : "plus"}
                label={myList.inList() ? t("In My List") : t("My List")}
                on={myList.inList()}
                onClick={() => void myList.toggle()}
              />
              <Show when={canRequest.value() && missing().length > 0}>
                <Action icon="download" label={t("More seasons")} onClick={() => void moreSeasons()} />
              </Show>
            </div>
            <Show when={note()}>
              <span class="status-line">{note()}</span>
            </Show>
          </div>
          <Show when={details.value()}>
            {(d) => <Credits cast={d().cast} directors={d().directors} createdBy />}
          </Show>
        </div>
      </section>

      <section class="section">
        <Show when={episodes.value()} fallback={<GhostRow variant="wide" />}>
          <div class="season-tabs" role="tablist">
            <For each={seasons()}>
              {(s) => (
                <button
                  role="tab"
                  aria-selected={season() === s ? "true" : "false"}
                  class={["season-tab", { selected: season() === s }]}
                  onClick={() => {
                    setPicked(s);
                    setLimit(EPISODES_PAGE);
                  }}
                >
                  {s === 0 ? t("Specials") : t("Season {n}", { n: s })}
                </button>
              )}
            </For>
          </div>
          <div class="episodes">
            <For each={shown()}>
              {(e) => (
                <button class="episode" onClick={() => playEpisode(e)}>
                  <div class="still">
                    <Show when={imageUrl(e.episode_still ?? e.backdrop)}>
                      {(src) => <img src={src()} alt="" loading="lazy" decoding="async" />}
                    </Show>
                    <span class="play-over">
                      <Icon name="play" size={32} />
                    </span>
                    <Progress fraction={e.progress && !e.progress.finished ? e.progress.fraction : 0} />
                  </div>
                  <div>
                    <div class="episode-title">{`${e.episode ?? ""}. ${e.episode_title ?? e.title}`}</div>
                    <div class="episode-meta">
                      {facts([
                        runtime(e.duration_secs),
                        e.progress?.finished
                          ? t("Watched")
                          : e.progress && e.duration_secs
                            ? t("{t} left", { t: runtime(e.duration_secs - e.progress.position_secs) })
                            : null,
                      ])}
                    </div>
                    <p class="episode-overview">{e.episode_overview ?? ""}</p>
                  </div>
                </button>
              )}
            </For>
            {/* The next episode to air, greyed at the end of its season (the TV's). */}
            <Show
              when={
                upcomingInSeason() &&
                upcomingInSeason()!.season === season() &&
                shown().length === inSeason().length
              }
            >
              {(() => {
                const n = upcomingInSeason()!;
                return (
                  <div class="episode upcoming">
                    <div class="still" />
                    <div>
                      <div class="episode-title">{`${n.episode}. ${n.name ?? t("Episode {n}", { n: n.episode })}`}</div>
                      <div class="episode-meta accent">
                        {n.air_date
                          ? t("Coming {date}", { date: longDate(n.air_date) ?? "" })
                          : t("Coming soon")}
                      </div>
                      <p class="episode-overview">{n.overview ?? ""}</p>
                    </div>
                  </div>
                );
              })()}
            </Show>
          </div>
          <Show when={inSeason().length > limit()}>
            <div style={{ padding: "16px var(--gutter) 0" }}>
              <button class="btn" onClick={() => setLimit((n) => n + EPISODES_PAGE)}>
                {t("Show more")}
              </button>
            </div>
          </Show>
        </Show>
      </section>

      {/* Your shows first (one per show across libraries), then ones you could request. */}
      <Show when={similar.value() && suggestions.value()} fallback={<GhostRow />}>
        <MoreRow
          title={t("More Like This")}
          items={[
            ...(similar.value() ?? [])
              .filter((x, i, all) => !x.tmdb_id || all.findIndex((y) => y.tmdb_id === x.tmdb_id) === i)
              .map((s) => ({ show: s })),
            ...(suggestions.value() ?? []).map((suggestion) => ({ suggestion })),
          ]}
        />
      </Show>
      <PeopleRow people={[...(details.value()?.directors ?? []), ...(details.value()?.cast ?? [])]} />
      <div class="section facts-grid">
        <Facts
          title={t("About")}
          facts={[{ label: show.value()?.meta_title ?? name, value: show.value()?.overview }]}
        />
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
                ? `${t("{seasons} seasons, {episodes} episodes", { seasons: seasons().length, episodes: episodes.value()!.length })}, ${t("{n} watched", { n: episodes.value()!.filter((e) => e.progress?.finished).length })}`
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
      </div>
    </>
  );
}

export default function SeriesPage() {
  const params = useParams<{ name: string }>();
  return (
    <Show when={params.name} keyed>
      {(name) => <SeriesView name={name} />}
    </Show>
  );
}
