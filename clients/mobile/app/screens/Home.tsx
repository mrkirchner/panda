// Home, as on the TV (`/api/home`, then `/api/home/more`): featured titles to swipe through,
// Continue Watching, My List, holidays in season, recently added movies, genres, recently added
// shows, a spotlight, top picks, and today's themes.
import { Screen, type ScrollView } from "@nativescript/core";
import { api, ensureSession, imageUrl } from "@tv/api/client";
import type { ContinueEntry, Featured, Home as HomeData, HomeMore, Spot, ThemedRow, Title } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";
import { play } from "../player";
import { Banner, GenreTile, Poster, Row, WideCard } from "./cards";
import { openGenre, openPreview, openSeries, openSpot, openTitle } from "./links";
import { bestProgress } from "../requests";
import type { MyRequest } from "@tv/api/types";

const asFeatured = (f: Featured | Title): Featured =>
  "kind" in f ? { reason: "Recently added", movie: f } : f;

/** A hero slide as a Spot (what it is, why it's featured). */
function heroSpot(f: Featured): Spot {
  const m = f.movie;
  const s = f.series;
  return {
    kind: m ? "movie" : "series",
    id: m ? m.id : (s?.series ?? ""),
    title: m ? m.title : (s?.meta_title ?? s?.series ?? ""),
    year: m ? m.year : (s?.year ?? null),
    genres: m ? m.genres : (s?.genres ?? null),
    rating: m ? m.rating : (s?.rating ?? null),
    poster: m ? m.poster : (s?.poster ?? null),
    backdrop: m ? m.backdrop : (s?.backdrop ?? null),
    logo: f.logo ?? null,
    reason: f.reason,
    reason_title: null,
  };
}

function resume(e: ContinueEntry) {
  const at = e.up_next ? 0 : e.position_secs;
  const target =
    e.kind === "movie" && e.title_id ? { kind: "title" as const, id: e.title_id } : { kind: "item" as const, id: e.item_id };
  play(target, at).catch(err => console.log(`play failed: ${String(err)}`));
}

/** Featured titles, one screen wide each, swiped like pages. */
function Hero(props: { slides: Spot[] }) {
  const width = Screen.mainScreen.widthDIPs;
  return (
    <scrollview
      orientation="horizontal"
      scrollBarIndicatorVisible={false}
      on:loaded={(e: { object: ScrollView }) => {
        (e.object.ios as UIScrollView).pagingEnabled = true;
      }}
    >
      <stacklayout orientation="horizontal">
        <For each={props.slides}>
          {s => (
            <stacklayout width={width} on:tap={() => openSpot(s)}>
              <image class="hero" width={width} src={imageUrl(s.backdrop)} stretch="aspectFill" />
              <stacklayout class="hero-text">
                <label class="small accent" text={t(s.reason)} />
                <label class="h1" textWrap={true} text={s.title} />
              </stacklayout>
            </stacklayout>
          )}
        </For>
      </stacklayout>
    </scrollview>
  );
}

/** A themed row (Christmas, Heists): the titles you have. */
function Themed(props: { row: ThemedRow }) {
  return (
    <Show when={props.row.items.length}>
      <Row title={t(props.row.title)}>
        <For each={props.row.items}>{s => <Poster image={s.poster} title={s.title} onTap={() => openSpot(s)} />}</For>
      </Row>
    </Show>
  );
}

export function Home() {
  const data = load<HomeData>(async () => {
    await ensureSession();
    return api.home();
  });
  // The rest takes longer and never holds up the first rows.
  const more = load<HomeMore | null>(async () => {
    await ensureSession();
    return api.homeMore().catch(() => null);
  });
  const home = () => data.value();
  /** Requests still on their way: first in My List, with how they're going. */
  const requests = load<MyRequest[]>(async () => {
    await ensureSession();
    return (await api.myRequests().catch(() => [] as MyRequest[])).filter(
      r => !r.title_id && !r.series && r.status !== "failed",
    );
  });
  const requestBadge = (r: MyRequest) => {
    const p = bestProgress(r);
    if (p?.state === "downloading") return t("Downloading {p}%", { p: Math.round(p.fraction * 100) });
    if (p?.state === "importing") return t("Importing");
    if (p?.state === "searching") return t("Searching");
    return t("Requested");
  };
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
        <Show when={home()?.featured.length}>
          <Hero slides={home()!.featured.map(f => heroSpot(asFeatured(f)))} />
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
        <Show when={(home()?.my_list.length ?? 0) + (requests.value()?.length ?? 0) > 0}>
          <Row title={t("My List")}>
            <For each={requests.value() ?? []}>
              {r => (
                <Poster
                  image={r.poster}
                  title={r.title}
                  badge={requestBadge(r)}
                  fraction={bestProgress(r)?.state === "downloading" ? bestProgress(r)!.fraction : 0}
                  onTap={() => r.tmdb_id && openPreview(r.kind, r.tmdb_id)}
                />
              )}
            </For>
            <For each={home()?.my_list ?? []}>
              {m => (
                <Poster
                  image={m.poster}
                  title={m.title}
                  onTap={() => (m.kind === "title" ? openTitle(m.id) : openSeries(m.id))}
                />
              )}
            </For>
          </Row>
        </Show>
        <For each={seasonal()}>{row => <Themed row={row} />}</For>
        <Show when={home()?.recently_added_movies.length}>
          <Row title={t("Recently Added Movies")}>
            <For each={home()!.recently_added_movies}>
              {m => (
                <Poster
                  image={m.poster}
                  title={m.title}
                  fraction={m.progress && !m.progress.finished ? m.progress.fraction : 0}
                  onTap={() => openTitle(m.id)}
                />
              )}
            </For>
          </Row>
        </Show>
        <Show when={more.value()?.genres.length}>
          <Row title={t("Browse by genre")}>
            <For each={more.value()!.genres}>
              {g => <GenreTile name={g.name} image={g.backdrop} onTap={() => openGenre(g.name)} />}
            </For>
          </Row>
        </Show>
        <Show when={home()?.recently_added_shows.length}>
          <Row title={t("Recently Added Shows")}>
            <For each={home()!.recently_added_shows}>
              {s => <Poster image={s.poster} title={s.meta_title ?? s.series} onTap={() => openSeries(s.series)} />}
            </For>
          </Row>
        </Show>
        <Show when={more.value()?.spotlights[0]}>
          <Banner spot={more.value()!.spotlights[0]} onTap={() => openSpot(more.value()!.spotlights[0])} />
        </Show>
        <Show when={more.value()?.top_picks.length}>
          <Row title={t("Top picks for you")}>
            <For each={more.value()!.top_picks}>
              {s => <Poster image={s.poster} title={s.title} onTap={() => openSpot(s)} />}
            </For>
          </Row>
        </Show>
        <For each={daily()}>{row => <Themed row={row} />}</For>
      </stacklayout>
    </scrollview>
  );
}
