// Search, as the TV's (`/api/find`, its slower halves `/api/find/more` from Radarr/Sonarr and
// `/api/find/people` from TMDB): Movies and Shows (yours first, then ones you could request,
// badged) and People (first when the search is someone's name). Predictions from your library as
// you type, and voice search (the browser's speech recognition, the TV's voice.ts). Before
// typing: Top picks and TMDB's trending rows. The query lives in the address (?q=).
import { useSearchParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import type { Discover, DiscoverSet, FindResults, Person } from "@tv/api/types";
import { t, tServer } from "@tv/i18n";
import { suggest } from "@tv/search/suggest";
import { fold } from "@tv/text";
import { startVoiceSearch, stopVoiceSearch, voiceHeard, voiceState, voiceSupported } from "@tv/voice";
import { For, Show, createSignal, onCleanup, onSettled } from "solid-js";
import { GhostRow } from "../components/cards";
import { Icon } from "../components/icons";
import { MoreRow, PeopleRow } from "../components/sections";
import { load } from "../data";

/** Search once typing pauses this long. */
const TYPING_MS = 350;
/** Titles per result row. */
const ROW_MAX = 40;

export default function Search() {
  const [params, setParams] = useSearchParams<{ q?: string }>();
  const picks = load(() => api.find({ picks: true, more: false }));
  const discover = load(() => api.discover().catch(() => [] as DiscoverSet[]));
  /** Every title name in the library, for predictions (asked once, on the first letter). */
  const [names, setNames] = createSignal<string[]>([]);
  let namesAsked = false;
  const [text, setText] = createSignal(() => params.q ?? "");
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<FindResults | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [more, setMore] = createSignal<Discover[]>([]);
  const [people, setPeople] = createSignal<Person[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;
  let field: HTMLInputElement | undefined;

  const search = (q: string) => {
    const n = ++asked;
    const trimmed = q.trim();
    setParams({ q: trimmed || undefined }, { replace: true });
    if (!trimmed) {
      setQuery("");
      setResults(null);
      setMore([]);
      setPeople([]);
      setBusy(false);
      return;
    }
    if (!results()) setBusy(true);
    api
      .find({ q: trimmed, more: false })
      .then(r => {
        if (n !== asked) return;
        setQuery(trimmed);
        setResults(r);
        setMore([]);
        setPeople([]);
      })
      .catch(() => n === asked && setResults({ movies: [], shows: [], more: [] }))
      .finally(() => n === asked && setBusy(false));
    api.findMore(trimmed).then(
      m => n === asked && setMore(m.more),
      () => {},
    );
    api.findPeople(trimmed).then(
      p => n === asked && setPeople(p),
      () => {},
    );
  };
  const typed = (q: string) => {
    setText(q);
    clearTimeout(timer);
    timer = setTimeout(() => search(q), TYPING_MS);
    if (!namesAsked && q.trim()) {
      namesAsked = true;
      void Promise.all([api.titles().catch(() => []), api.series().catch(() => [])]).then(([m, s]) =>
        setNames([...m.map(x => x.title), ...s.map(x => x.meta_title ?? x.series)]),
      );
    }
  };
  /** Up to five of your titles matching what's typed (the TV's predictions). */
  const predictions = () => {
    const q = text().trim();
    if (q.length < 2) return [];
    return suggest(names(), q, 5).filter(p => fold(p) !== fold(q));
  };
  const choose = (q: string) => {
    setText(q);
    if (field) field.value = q;
    clearTimeout(timer);
    search(q);
  };

  onSettled(() => {
    if (params.q) search(params.q);
    else field?.focus();
  });
  onCleanup(() => {
    clearTimeout(timer);
    stopVoiceSearch();
  });

  const voice = () => {
    if (voiceState() === "listening") return stopVoiceSearch();
    startVoiceSearch(heard => choose(heard));
  };

  /** The search is someone's name (the best match's starts with it): People comes first. */
  const personFirst = () => {
    const name = people()[0]?.name;
    const q = query();
    return !!name && q.length >= 4 && fold(name).startsWith(fold(q));
  };
  const shown = () => (query() ? results() : (picks.value() ?? null));

  return (
    <div style={{ "padding-top": "calc(var(--topbar-h) + 12px)" }}>
      <form class="search-bar" role="search" onSubmit={e => {
        e.preventDefault();
        choose(text());
        field?.blur();
      }}>
        <label class="search-field">
          <span class="sr-only">{t("Search")}</span>
          <Icon name="search" size={20} />
          <input
            ref={el => (field = el)}
            class="input"
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            placeholder={t("Movies, shows and people")}
            value={text()}
            onInput={e => typed(e.currentTarget.value)}
          />
        </label>
        <Show when={voiceSupported()}>
          <button
            type="button"
            class={["icon-btn", "glass", { on: voiceState() === "listening" }]}
            aria-label={t("Voice search")}
            onClick={voice}
          >
            <Icon name="mic" />
          </button>
        </Show>
      </form>
      <Show when={voiceState() !== "idle"}>
        <p class="listening" role="status">
          {voiceState() === "listening" ? voiceHeard() || t("Listening...") : voiceHeard()}
        </p>
      </Show>
      <Show when={predictions().length}>
        <div class="suggestions">
          <For each={predictions()}>
            {p => (
              <button class="chip" onClick={() => choose(p)}>
                {p}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={busy() || (!query() && !picks.value())}>
        <GhostRow />
        <GhostRow />
      </Show>
      <Show when={query() && personFirst()}>
        <PeopleRow title={t("People")} people={people().slice(0, ROW_MAX)} />
      </Show>
      <MoreRow
        title={query() ? t("Movies") : t("Top picks")}
        items={[
          ...(shown()?.movies ?? []).map(title => ({ title })),
          ...(query() ? more().filter(d => d.kind === "movie") : []).map(suggestion => ({ suggestion })),
        ].slice(0, ROW_MAX)}
      />
      <MoreRow
        title={t("Shows")}
        items={[
          ...(shown()?.shows ?? []).map(show => ({ show })),
          ...(query() ? more().filter(d => d.kind === "series") : []).map(suggestion => ({ suggestion })),
        ].slice(0, ROW_MAX)}
      />
      <Show when={query() && !personFirst()}>
        <PeopleRow title={t("People")} people={people().slice(0, ROW_MAX)} />
      </Show>
      <Show when={!query()}>
        <For each={discover.value() ?? []}>
          {set => <MoreRow title={tServer(set.title)} items={set.items.map(suggestion => ({ suggestion }))} />}
        </For>
      </Show>
      <Show
        when={
          query() &&
          results() &&
          !busy() &&
          !results()!.movies.length &&
          !results()!.shows.length &&
          !more().length &&
          !people().length
        }
      >
        <p class="empty">{t("Nothing in your library matches.")}</p>
      </Show>
    </div>
  );
}
