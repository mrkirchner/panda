// Search the library (`/api/find`): movies and shows as you type. Before typing, the library's
// top picks.
import { Dialogs, type SearchBar } from "@nativescript/core";
import { isListening, startListening, stopListening } from "../voice";
import { onTabShown } from "../tabs";
import { api } from "@tv/api/client";
import type { Discover, DiscoverSet, FindResults, Person } from "@tv/api/types";
import { t, tServer } from "@tv/i18n";
import { normalized } from "@tv/text";

/** For comparing names: no accents, case or extra spaces (the TV's). */
const fold = (x: string) =>
  normalized(x, "NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
import { For, Show, createSignal, onCleanup } from "solid-js";
import { load } from "../data";
import { GhostRow, Poster, Row } from "./cards";
import { openSeries, openTitle } from "./links";
import { MoreRow, PeopleRow } from "./sections";

/** Search once the typing pauses this long (a few keys at normal speed are one search). */
const TYPING_MS = 700;
/** Shorter than this searches nothing (one letter matches most of a library). */
const MIN_CHARS = 2;
/** Titles per result row (building many posters at once would hold up the keyboard). */
const ROW_MAX = 24;

/** Debug builds: a query to start with (devLaunch.tsx `search:<q>`). */
let startQuery = "";
export const setStartQuery = (q: string) => (startQuery = q);
/** Debug builds (`-pandaType <word>`): type into the bar a letter at a time, as a keyboard. */
export let devType: ((word: string) => void) | null = null;

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

  /** A key: nothing on screen changes until the typing pauses and the results are back (so the
   * keyboard never waits on the screen rebuilding). */
  /** When the last key was pressed: results wait until typing pauses before they're drawn. */
  let lastKey = 0;
  let held: (() => void) | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  /** Draw `apply` now if typing has paused, else once it does. */
  const whenIdle = (apply: () => void) => {
    const wait = lastKey + TYPING_MS - Date.now();
    if (wait <= 0) return apply();
    held = apply;
    clearTimeout(heldTimer);
    heldTimer = setTimeout(() => {
      const h = held;
      held = null;
      h?.();
    }, wait);
  };

  const search = (q: string) => {
    lastKey = Date.now();
    clearTimeout(timer);
    if (q.trim().length < MIN_CHARS && q.trim()) return;
    if (!q.trim()) {
      asked++;
      setQuery("");
      setResults(null);
      setMore([]);
      setPeople([]);
      setBusy(false);
      return;
    }
    timer = setTimeout(async () => {
      const n = ++asked;
      // Ghosts only for the first search (later ones keep showing the previous results).
      if (!results()) setBusy(true);
      try {
        const r = await api.find({ q: q.trim(), more: false });
        if (n !== asked) return;
        whenIdle(() => {
          if (n !== asked) return;
          setMore([]);
          setPeople([]);
          setQuery(q);
          setResults(r);
        });
        api.findMore(q.trim()).then(
          m => whenIdle(() => n === asked && setMore(m.more)),
          () => {},
        );
        api.findPeople(q.trim()).then(
          p => whenIdle(() => n === asked && setPeople(p)),
          () => {},
        );
      } catch {
        if (n === asked) setResults({ movies: [], shows: [], more: [] });
      } finally {
        if (n === asked) setBusy(false);
      }
    }, TYPING_MS);
  };

  let bar: SearchBar | undefined;
  const [listening, setListening] = createSignal(false);
  const voice = () => {
    if (isListening()) return stopListening();
    bar?.dismissSoftInput();
    return startListening({
      onText: text => {
        if (bar) bar.text = text;
        search(text);
      },
      onListening: setListening,
      onError: message => void Dialogs.alert(t(message)),
    });
  };
  // Choosing the Search tab puts the cursor in the bar (the keyboard comes up), as iOS apps do,
  // unless there's already a search on screen.
  onTabShown.set("Search", () => {
    if (!query().trim() && !(bar?.text ?? "").trim()) setTimeout(() => bar?.focus(), 250);
  });
  onCleanup(() => {
    onTabShown.delete("Search");
    stopListening();
    clearTimeout(timer);
    clearTimeout(heldTimer);
  });
  devType = word => {
    // Through iOS's text input, as the keyboard types (focus first).
    const field = (bar?.ios as UISearchBar | undefined)?.searchTextField;
    if (!field) return;
    field.becomeFirstResponder();
    let i = 0;
    const next = () => {
      if (i >= word.length) return;
      const started = Date.now();
      field.insertText(word[i++]);
      if (__DEV__) console.log(`TYPE now "${field.text}" (bar ${bar?.text}) focused=${field.isFirstResponder} in ${Date.now() - started} ms`);
      setTimeout(next, 120);
    };
    setTimeout(next, 500);
  };
  // After the screen is built (Solid 2 allows no writes while it is).
  if (startQuery) setTimeout(() => search(startQuery), 0);

  /** The search is someone's name (the best match's starts with it): People comes first. */
  const personFirst = () => {
    const name = people()[0]?.name;
    const q = query().trim();
    return !!name && q.length >= 4 && fold(name).startsWith(fold(q));
  };

  const shownResults = () => (query().trim() ? results() : (picks.value() ?? null));

  return (
    <stacklayout>
      <gridlayout columns="*, auto" rows="auto" class="search-row">
      <searchbar
        col={0}
        class="search"
        text={startQuery}
        hint={t("Movies and shows")}
        ref={(el: SearchBar) => (bar = el)}
        on:loaded={() => onTabShown.get("Search")?.()}
        on:textChange={(e: { object: SearchBar }) => search(e.object.text ?? "")}
        on:submit={(e: { object: SearchBar }) => e.object.dismissSoftInput()}
      />
        {/* Voice search, as the TV's Voice key: the words fill the bar as you speak. */}
        <gridlayout col={1} class={listening() ? "mic on" : "mic"} on:tap={() => void voice()}>
          <image class="mic-icon" src="sys://mic.fill" tintColor={listening() ? "#141210" : "#f4f1ea"} />
        </gridlayout>
      </gridlayout>
      <scrollview>
        <stacklayout class="home">
          {/* Ghost rows while a search (or the first screen) is on its way. */}
          <Show when={busy() || (!query().trim() && !picks.value())}>
            <GhostRow />
            <GhostRow />
          </Show>
          <Show when={!query().trim() && shownResults()}>
            <label class="muted search-note" text={t("Top picks")} />
          </Show>
          {/* People first when the search is someone's name (the TV's rule). */}
          <Show when={query().trim() && personFirst()}>
            <PeopleRow title={t("People")} people={people().slice(0, ROW_MAX)} />
          </Show>
          {/* Movies, then shows: yours first, then ones you could request (badged). */}
          <MoreRow
            title={t("Movies")}
            items={[
              ...(shownResults()?.movies ?? []).map(title => ({ title })),
              ...(query().trim() ? more().filter(d => d.kind === "movie") : []).map(suggestion => ({ suggestion })),
            ].slice(0, ROW_MAX)}
          />
          <MoreRow
            title={t("Shows")}
            items={[
              ...(shownResults()?.shows ?? []).map(show => ({ show })),
              ...(query().trim() ? more().filter(d => d.kind === "series") : []).map(suggestion => ({ suggestion })),
            ].slice(0, ROW_MAX)}
          />
          <Show when={query().trim() && !personFirst()}>
            <PeopleRow title={t("People")} people={people().slice(0, ROW_MAX)} />
          </Show>
          <Show when={!query().trim()}>
            <For each={discover.value() ?? []}>
              {set => <MoreRow title={tServer(set.title)} items={set.items.map(suggestion => ({ suggestion }))} />}
            </For>
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
