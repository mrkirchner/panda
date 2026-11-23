// Home, as on the TV (`/api/home`, then `/api/home/more`): the featured hero, Continue Watching,
// My List (your requests first), holidays in season, recently added movies (the expanding row),
// genres, recently added shows, a spotlight, top picks, and today's themes.
import { api, ensureSession } from "@tv/api/client";
import type { ContinueEntry, Home as HomeData, HomeMore, MyRequest, ThemedRow } from "@tv/api/types";
import { t, tServer } from "@tv/i18n";
import { For, Show, createMemo } from "solid-js";
import {
  Banner,
  ExpandRow,
  GenreTile,
  GhostHero,
  GhostRow,
  Poster,
  Row,
  WideCard,
} from "../components/cards";
import { Hero } from "../components/Hero";
import { featuredSlide } from "../components/heroSlides";
import { MoreRow } from "../components/sections";
import { facts, genres, load, runtime } from "../data";
import { href, paths } from "../nav";
import { play } from "../player/launch";
import { bestProgress, myRequests, requestBadge } from "../requests";

/** Continue Watching: play from where you were, then land on its page (as the TV does). */
function resume(e: ContinueEntry) {
  const at = e.up_next ? 0 : e.position_secs;
  const target =
    e.kind === "movie" && e.title_id
      ? { kind: "title" as const, id: e.title_id }
      : { kind: "item" as const, id: e.item_id };
  const after = e.title_id ? paths.title(e.title_id) : e.series ? paths.series(e.series) : undefined;
  play(target, at, after);
}

/** A themed row (Christmas, Heists): the titles you have, then popular ones you could request. */
function Themed(props: { row: ThemedRow }) {
  return (
    <MoreRow
      title={tServer(props.row.title)}
      items={[
        ...props.row.items.map((spot) => ({ spot })),
        ...props.row.more.map((suggestion) => ({ suggestion })),
      ]}
    />
  );
}

const requestHref = (r: MyRequest) =>
  r.title_id
    ? paths.title(r.title_id)
    : r.series
      ? paths.series(r.series)
      : r.tmdb_id
        ? paths.preview(r.kind, r.tmdb_id)
        : paths.myList;

export default function Home() {
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
  /** My List on Home (the TV's): requests not saved yet first, then saved titles a request
   * doesn't already show. */
  const listRequests = () => myRequests().filter((r) => !r.listed);
  const listEntries = () => {
    const shown = new Set(listRequests().flatMap((r) => [r.title_id, r.series].filter(Boolean)));
    return (home()?.my_list ?? []).filter((m) => !shown.has(m.id));
  };
  const heroSlides = createMemo(() =>
    (home()?.featured.length ? home()!.featured : (home()?.recently_added_movies ?? []).slice(0, 5)).map(
      featuredSlide,
    ),
  );
  const movieCards = createMemo(() =>
    (home()?.recently_added_movies ?? []).map((m) => ({
      key: m.id,
      title: m.title,
      poster: m.poster,
      backdrop: m.backdrop,
      meta: facts([m.year, runtime(m.duration_secs), genres(m.genres, 1)]),
      clip: { kind: "title" as const, id: m.id },
      fraction: m.progress && !m.progress.finished ? m.progress.fraction : 0,
      href: href(paths.title(m.id)),
    })),
  );
  const showCards = createMemo(() =>
    (home()?.recently_added_shows ?? []).map((s) => ({
      key: s.series,
      title: s.meta_title ?? s.series,
      poster: s.poster,
      backdrop: s.backdrop,
      meta: facts([s.year, t("{n} seasons", { n: s.seasons }), genres(s.genres, 1)]),
      clip: { kind: "series" as const, name: s.series },
      href: href(paths.series(s.series)),
    })),
  );
  const seasonal = () => (more.value()?.themed ?? []).filter((r) => r.seasonal);
  const daily = () => (more.value()?.themed ?? []).filter((r) => !r.seasonal);

  return (
    <>
      <Show when={data.error()}>
        <p class="empty error page-top">{data.error()}</p>
      </Show>
      {/* First visit: ghosts hold the page's shape until it arrives (the TV's). */}
      <Show when={!home() && !data.error()}>
        <GhostHero />
        <GhostRow variant="wide" />
        <GhostRow />
        <GhostRow variant="expand" />
      </Show>
      <Show when={heroSlides().length}>
        <Hero slides={heroSlides()} />
      </Show>
      <Show when={home()?.continue_watching.length}>
        <Row title={t("Continue Watching")}>
          <For each={home()!.continue_watching}>
            {(e) => (
              <WideCard
                image={e.backdrop ?? e.poster}
                title={e.title}
                subtitle={e.up_next ? `${t("Up next")}  ·  ${e.subtitle}` : e.subtitle}
                fraction={e.up_next ? 0 : e.fraction}
                onClick={() => resume(e)}
              />
            )}
          </For>
        </Row>
      </Show>
      <Show when={listEntries().length + listRequests().length > 0}>
        <Row title={t("My List")} link={{ label: t("See all"), href: href(paths.myList) }}>
          <For each={listRequests()}>
            {(r) => (
              <Poster
                image={r.poster}
                title={r.title}
                badge={requestBadge(r)?.label}
                badgeTone={requestBadge(r)?.tone}
                fraction={bestProgress(r)?.state === "downloading" ? bestProgress(r)!.fraction : 0}
                href={href(requestHref(r))}
              />
            )}
          </For>
          <For each={listEntries()}>
            {(m) => (
              <Poster
                image={m.poster}
                title={m.title}
                href={href(m.kind === "title" ? paths.title(m.id) : paths.series(m.id))}
              />
            )}
          </For>
        </Row>
      </Show>
      <For each={seasonal()}>{(row) => <Themed row={row} />}</For>
      <Show when={movieCards().length}>
        <ExpandRow
          title={t("Recently Added Movies")}
          items={movieCards()}
          link={{ label: t("See all"), href: href(paths.all("movies", {})) }}
        />
      </Show>
      <Show when={more.value()?.genres.length}>
        <Row title={t("Browse by genre")}>
          <For each={more.value()!.genres}>{(g) => <GenreTile name={g.name} image={g.backdrop} />}</For>
        </Row>
      </Show>
      <Show when={showCards().length}>
        <ExpandRow
          title={t("Recently Added Shows")}
          items={showCards()}
          link={{ label: t("See all"), href: href(paths.all("shows", {})) }}
        />
      </Show>
      <Show when={more.value()?.spotlights[0]}>{(s) => <Banner spot={s()} />}</Show>
      {/* The slower half (genres, picks, themes) still on its way. */}
      <Show when={home() && more.value() === undefined}>
        <GhostRow variant="genre" />
        <GhostRow />
      </Show>
      <Show when={more.value()?.top_picks.length}>
        <Row title={t("Top picks for you")}>
          <For each={more.value()!.top_picks}>
            {(s) => <Poster image={s.poster} title={s.title} href={href(paths.spot(s))} />}
          </For>
        </Row>
      </Show>
      <For each={daily()}>{(row) => <Themed row={row} />}</For>
    </>
  );
}
