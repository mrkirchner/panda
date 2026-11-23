// Search the library (`/api/find`): movies and shows as you type. Before typing, the library's
// top picks.
import type { SearchBar } from "@nativescript/core";
import { api } from "@tv/api/client";
import type { Discover, DiscoverSet, FindResults, Person } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { load } from "../data";
import { Poster, Row } from "./cards";
import { openSeries, openTitle } from "./links";
import { MoreRow, PeopleRow } from "./sections";

/** Wait this long after the last key before searching. */
const TYPING_MS = 300;

/** Debug builds: a query to start with (devLaunch.tsx `search:<q>`). */
let startQuery = "";
export const setStartQuery = (q: string) => (startQuery = q);

export function Search() {
  const picks = load(() => api.find({ picks: true, more: false }));
  /** Trending and "Popular on <service>" (TMDB), minus what you have: requestable. */
  const discover = load(() => api.discover().catch(() => [] as DiscoverSet[]));
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<FindResults | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** Search's slower halves: titles you don't have (Radarr/Sonarr lookup), and people (TMDB). */
  const [more, setMore] = createSignal<Discover[]>([]);
  const [people, setPeople] = createSignal<Person[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;

  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer);
    if (!q.trim()) {
      setResults(null);
      setMore([]);
      setPeople([]);
      return;
    }
    timer = setTimeout(async () => {
      const n = ++asked;
      setBusy(true);
      try {
        const r = await api.find({ q: q.trim(), more: false });
        if (n === asked) setResults(r);
        api.findMore(q.trim()).then(
          m => n === asked && setMore(m.more),
          () => {},
        );
        api.findPeople(q.trim()).then(
          p => n === asked && setPeople(p),
          () => {},
        );
      } catch {
        if (n === asked) setResults({ movies: [], shows: [], more: [] });
      } finally {
        if (n === asked) setBusy(false);
      }
    }, TYPING_MS);
  };

  // After the screen is built (Solid 2 allows no writes while it is).
  if (startQuery) setTimeout(() => search(startQuery), 0);

  const shownResults = () => (query().trim() ? results() : (picks.value() ?? null));

  return (
    <stacklayout>
      <searchbar
        class="search"
        text={startQuery}
        hint={t("Movies and shows")}
        on:textChange={(e: { object: SearchBar }) => search(e.object.text ?? "")}
        on:submit={(e: { object: SearchBar }) => e.object.dismissSoftInput()}
      />
      <scrollview>
        <stacklayout class="home">
          <Show when={busy()}>
            <activityindicator busy={true} class="mt24" />
          </Show>
          <Show when={!query().trim() && shownResults()}>
            <label class="muted search-note" text={t("Top picks")} />
          </Show>
          <Show when={shownResults()?.movies.length}>
            <Row title={t("Movies")}>
              <For each={shownResults()!.movies}>
                {m => <Poster image={m.poster} title={m.title} onTap={() => openTitle(m.id)} />}
              </For>
            </Row>
          </Show>
          <Show when={shownResults()?.shows.length}>
            <Row title={t("Shows")}>
              <For each={shownResults()!.shows}>
                {s => <Poster image={s.poster} title={s.meta_title ?? s.series} onTap={() => openSeries(s.series)} />}
              </For>
            </Row>
          </Show>
          <Show when={!query().trim()}>
            <For each={discover.value() ?? []}>
              {set => <MoreRow title={t(set.title)} items={set.items.map(suggestion => ({ suggestion }))} />}
            </For>
          </Show>
          <Show when={query().trim()}>
            <MoreRow title={t("Not in your library")} items={more().map(suggestion => ({ suggestion }))} />
            <PeopleRow people={people()} />
          </Show>
          <Show
            when={
              query().trim() &&
              results() &&
              !busy() &&
              !results()!.movies.length &&
              !results()!.shows.length &&
              !more().length &&
              !people().length
            }
          >
            <label class="muted search-note" textWrap={true} text={t("Nothing in your library matches.")} />
          </Show>
        </stacklayout>
      </scrollview>
    </stacklayout>
  );
}
