// Search the library (`/api/find`): movies and shows as you type. Before typing, the library's
// top picks.
import type { SearchBar } from "@nativescript/core";
import { api } from "@tv/api/client";
import type { FindResults } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { load } from "../data";
import { Poster, Row } from "./cards";
import { openSeries, openTitle } from "./links";

/** Wait this long after the last key before searching. */
const TYPING_MS = 300;

export function Search() {
  const picks = load(() => api.find({ picks: true, more: false }));
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<FindResults | null>(null);
  const [busy, setBusy] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;

  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer);
    if (!q.trim()) {
      setResults(null);
      return;
    }
    timer = setTimeout(async () => {
      const n = ++asked;
      setBusy(true);
      try {
        const r = await api.find({ q: q.trim(), more: false });
        if (n === asked) setResults(r);
      } catch {
        if (n === asked) setResults({ movies: [], shows: [], more: [] });
      } finally {
        if (n === asked) setBusy(false);
      }
    }, TYPING_MS);
  };

  const shownResults = () => (query().trim() ? results() : (picks.value() ?? null));

  return (
    <stacklayout>
      <searchbar
        class="search"
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
          <Show
            when={query().trim() && results() && !busy() && !results()!.movies.length && !results()!.shows.length}
          >
            <label class="muted search-note" textWrap={true} text={t("Nothing in your library matches.")} />
          </Show>
        </stacklayout>
      </scrollview>
    </stacklayout>
  );
}
