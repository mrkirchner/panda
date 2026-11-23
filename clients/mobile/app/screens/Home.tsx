// Home, as on the TV (`/api/home`, then `/api/home/more`): featured titles to swipe through,
// Continue Watching, My List, holidays in season, recently added movies, genres, recently added
// shows, a spotlight, top picks, and today's themes.
import { api, ensureSession } from "@tv/api/client";
import type { ContinueEntry, Home as HomeData, HomeMore, ThemedRow } from "@tv/api/types";
import { t, tServer } from "@tv/i18n";
import { For, Show } from "solid-js";
import { facts, load, runtime } from "../data";
import { play } from "../player";
import { Banner, ExpandRow, GenreTile, Poster, Row, WideCard } from "./cards";
import { Hero } from "./Hero";
import { featuredSlide } from "./heroSlides";
import { openGenre, openPreview, openSeries, openTitle, peekMovie, peekShow, peekSpot } from "./links";
import { bestProgress, myRequests, requestBadge } from "../requests";
import { OfflineBanner } from "../offline";
import { MoreRow } from "./sections";
import { Dialogs } from "@nativescript/core";
import type { MyRequest } from "@tv/api/types";

/** Continue Watching: play from where you were, then land on its page (as the TV does). */
function resume(e: ContinueEntry) {
  const at = e.up_next ? 0 : e.position_secs;
  const target =
    e.kind === "movie" && e.title_id ? { kind: "title" as const, id: e.title_id } : { kind: "item" as const, id: e.item_id };
  const page = e.title_id ? () => openTitle(e.title_id!) : e.series ? () => openSeries(e.series!) : undefined;
  play(target, at, page).catch(err => void Dialogs.alert(err instanceof Error ? err.message : String(err)));
}

/** A themed row (Christmas, Heists): the titles you have, then popular ones you could request. */
function Themed(props: { row: ThemedRow }) {
  return (
    <MoreRow
      title={tServer(props.row.title)}
      items={[...props.row.items.map(spot => ({ spot })), ...props.row.more.map(suggestion => ({ suggestion }))]}
    />
  );
}

export function Home() {
  const data = load<HomeData>(
    async () => {
      await ensureSession();
      return api.home();
    },
    { live: true },
  );
  // The rest takes longer and never holds up the first rows.
  const more = load<HomeMore | null>(async () => {
    await ensureSession();
    return api.homeMore().catch(() => null);
  });
  const home = () => data.value();
  /** My List on Home (the TV's): requests not saved yet first (with their badge: on its way,
   * Ready, Failed), then saved titles a request doesn't already show. */
  const listRequests = () => myRequests().filter(r => !r.listed);
  const listEntries = () => {
    const shown = new Set(listRequests().flatMap(r => [r.title_id, r.series].filter(Boolean)));
    return (home()?.my_list ?? []).filter(m => !shown.has(m.id));
  };
  const openRequest = (r: MyRequest) =>
    r.title_id ? openTitle(r.title_id) : r.series ? openSeries(r.series) : r.tmdb_id && openPreview(r.kind, r.tmdb_id);
  const seasonal = () => (more.value()?.themed ?? []).filter(r => r.seasonal);
  const daily = () => (more.value()?.themed ?? []).filter(r => !r.seasonal);

  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <Show when={!home() && !data.error()}>
          <activityindicator busy={true} class="mt40" />
        </Show>
        <OfflineBanner />
        {/* Nothing featured: the newest movies take the hero (as the TV does). */}
        <Show when={home()?.featured.length || home()?.recently_added_movies.length}>
          <Hero
            slides={(home()!.featured.length ? home()!.featured : home()!.recently_added_movies.slice(0, 5)).map(
              featuredSlide,
            )}
          />
        </Show>
        <Show when={home()?.continue_watching.length}>
          <Row title={t("Continue Watching")}>
            <For each={home()!.continue_watching}>
              {e => (
                <WideCard
                  image={e.backdrop ?? e.poster}
                  title={e.title}
                  subtitle={e.up_next ? `${t("Up next")}  |  ${e.subtitle}` : e.subtitle}
                  fraction={e.up_next ? 0 : e.fraction}
                  onTap={() => resume(e)}
                />
              )}
            </For>
          </Row>
        </Show>
        <Show when={listEntries().length + listRequests().length > 0}>
          <Row title={t("My List")}>
            <For each={listRequests()}>
              {r => (
                <Poster
                  image={r.poster}
                  title={r.title}
                  badge={requestBadge(r)}
                  fraction={bestProgress(r)?.state === "downloading" ? bestProgress(r)!.fraction : 0}
                  onTap={() => openRequest(r)}
                />
              )}
            </For>
            <For each={listEntries()}>
              {m => (
                <Poster
                  image={m.poster}
                  title={m.title}
                  onTap={() => (m.kind === "title" ? peekMovie(m.id) : peekShow(m.id))}
                />
              )}
            </For>
          </Row>
        </Show>
        <For each={seasonal()}>{row => <Themed row={row} />}</For>
        <Show when={home()?.recently_added_movies.length}>
          <ExpandRow
            title={t("Recently Added Movies")}
            items={home()!.recently_added_movies.map(m => ({
              key: m.id,
              title: m.title,
              poster: m.poster,
              backdrop: m.backdrop,
              meta: facts([m.year, runtime(m.duration_secs), (m.genres ?? "").split(/,\s*/)[0]]),
              clip: { kind: "title" as const, id: m.id },
              fraction: m.progress && !m.progress.finished ? m.progress.fraction : 0,
              open: () => openTitle(m.id),
            }))}
          />
        </Show>
        <Show when={more.value()?.genres.length}>
          <Row title={t("Browse by genre")}>
            <For each={more.value()!.genres}>
              {g => <GenreTile name={g.name} image={g.backdrop} onTap={() => openGenre(g.name)} />}
            </For>
          </Row>
        </Show>
        <Show when={home()?.recently_added_shows.length}>
          <ExpandRow
            title={t("Recently Added Shows")}
            items={home()!.recently_added_shows.map(s => ({
              key: s.series,
              title: s.meta_title ?? s.series,
              poster: s.poster,
              backdrop: s.backdrop,
              meta: facts([s.year, t("{n} seasons", { n: s.seasons }), (s.genres ?? "").split(/,\s*/)[0]]),
              clip: { kind: "series" as const, name: s.series },
              open: () => openSeries(s.series),
            }))}
          />
        </Show>
        <Show when={more.value()?.spotlights[0]}>
          <Banner spot={more.value()!.spotlights[0]} onTap={() => peekSpot(more.value()!.spotlights[0])} />
        </Show>
        <Show when={more.value()?.top_picks.length}>
          <Row title={t("Top picks for you")}>
            <For each={more.value()!.top_picks}>
              {s => <Poster image={s.poster} title={s.title} onTap={() => peekSpot(s)} />}
            </For>
          </Row>
        </Show>
        <For each={daily()}>{row => <Themed row={row} />}</For>
      </stacklayout>
    </scrollview>
  );
}
