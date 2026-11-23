// Every movie or show, as the TV's library grid (Library.tsx): posters three across with their
// progress, sorted and filtered with the TV's own rules (`@tv/library/browse`: A-Z ignoring
// "The", Recently added, Top rated, Newest, Unwatched first; a genre; one library when there
// are several of the kind), the count, in a virtual list (only the rows on screen exist,
// reused while scrolling).
import { Dialogs, Screen, type ContentView } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Library } from "@tv/api/types";
import { t, tn } from "@tv/i18n";
import { browse, genresOf, type BrowseEntry, type SortBy } from "@tv/library/browse";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { load } from "../data";
import { Progress } from "./cards";
import { createVirtualList } from "../virtual";
import { openSeries, openTitle } from "./links";

/** The TV's sort menu. */
const SORTS: { id: SortBy; label: string }[] = [
  { id: "az", label: "A-Z" },
  { id: "added", label: "Recently added" },
  { id: "rating", label: "Top rated" },
  { id: "year", label: "Newest" },
  { id: "unwatched", label: "Unwatched first" },
];

interface Entry extends BrowseEntry {
  library: number;
  poster: string | null;
  progress: number;
  open: () => void;
}

export function allScreen(kind: "movies" | "shows", genre?: string, library?: number) {
  const libraries = load(() => api.libraries().catch(() => [] as Library[]));
  const list = load<Entry[]>(
    async () =>
      kind === "movies"
        ? (await api.titles()).map(m => ({
            key: m.id,
            title: m.title,
            year: m.year,
            rating: m.rating,
            genres: m.genres,
            added: m.added_at,
            watched: m.progress?.finished,
            library: m.library_id,
            poster: m.poster,
            progress: m.progress && !m.progress.finished ? m.progress.fraction : 0,
            open: () => openTitle(m.id),
          }))
        : (await api.series()).map(s => ({
            key: s.series,
            title: s.meta_title ?? s.series,
            year: s.year,
            rating: s.rating,
            genres: s.genres,
            added: s.latest_added_at ?? "",
            library: s.library_id,
            poster: s.poster,
            progress: 0,
            open: () => openSeries(s.series),
          })),
    { live: true },
  );
  const [sort, setSort] = createSignal<SortBy>("az");
  const [genreSel, setGenre] = createSignal<string | null>(genre ?? null);
  const [only, setOnly] = createSignal<number | null>(library ?? null);
  /** This kind's libraries: a Library choice only when there are several. */
  const ofKind = () => (libraries.value() ?? []).filter(l => l.kind === kind);
  const entries = createMemo(() => {
    const all = (list.value() ?? []).filter(e => only() === null || e.library === only());
    return browse(all, { sort: sort(), unwatchedOnly: false, genre: genreSel() });
  });
  const genres = createMemo(() => genresOf(list.value() ?? []));

  const pick = async (title: string, options: string[], apply: (i: number) => void) => {
    const choice = await Dialogs.action({ title, cancelButtonText: t("Cancel"), actions: options });
    const i = options.indexOf(choice);
    if (i >= 0) {
      apply(i);
    }
  };
  const sortMenu = () =>
    pick(
      t("Sort"),
      SORTS.map(s => t(s.label)),
      i => setSort(SORTS[i].id),
    );
  const genreMenu = () =>
    pick(t("Genre"), [t("All genres"), ...genres().map(g => t(g))], i => setGenre(i === 0 ? null : genres()[i - 1]));
  const libraryMenu = () =>
    pick(t("Library"), [t("All libraries"), ...ofKind().map(l => l.name)], i =>
      setOnly(i === 0 ? null : ofKind()[i - 1].id),
    );

  // Three posters across, 16 at the sides and 10 between.
  const width = Math.floor((Screen.mainScreen.widthDIPs - 32 - 20) / 3);
  const height = Math.round(width * 1.5);
  const label = (prefix: string, value: string) => `${prefix}: ${value}  ▾`;

  /** The grid as rows of three in a virtual list: only the rows on screen exist. */
  const rows = createMemo(() => {
    const all = entries();
    const out: Entry[][] = [];
    for (let i = 0; i < all.length; i += 3) out.push(all.slice(i, i + 3));
    return out;
  });
  const grid = createVirtualList<Entry[]>(height + 10, row => (
    <stacklayout orientation="horizontal" class="grid-row">
      <For each={row()}>
        {(e, i) => (
          <gridlayout class="grid-cell" width={width} height={height} marginRight={i() === 2 ? 0 : 10} rows="*, auto" on:tap={() => e.open()}>
            <Show when={!e.poster}>
              <label rowSpan={2} class="small center poster-name" textWrap={true} text={e.title} />
            </Show>
            <image loadMode="async" rowSpan={2} class="grid-poster" src={imageUrl(e.poster)} stretch="aspectFill" />
            <Show when={e.watched}>
              <label rowSpan={2} class="watched-mark" text="✓" />
            </Show>
            <Show when={e.progress > 0}>
              <Progress row={1} fraction={e.progress} width={width} />
            </Show>
          </gridlayout>
        )}
      </For>
    </stacklayout>
  ));
  createEffect(rows, r => grid.update(r));

  return (
    <gridlayout rows="auto, auto, *" class="all-page">
      <scrollview row={0} orientation="horizontal" scrollBarIndicatorVisible={false}>
        <stacklayout orientation="horizontal" class="all-chips">
          <label
            class="chip"
            text={label(t("Sort"), t(SORTS.find(s => s.id === sort())!.label))}
            on:tap={() => void sortMenu()}
          />
          <label
            class={genreSel() ? "chip on" : "chip"}
            text={label(t("Genre"), genreSel() ? t(genreSel()!) : t("All"))}
            on:tap={() => void genreMenu()}
          />
          <Show when={ofKind().length > 1}>
            <label
              class={only() !== null ? "chip on" : "chip"}
              text={label(t("Library"), ofKind().find(l => l.id === only())?.name ?? t("All"))}
              on:tap={() => void libraryMenu()}
            />
          </Show>
        </stacklayout>
      </scrollview>
      <stacklayout row={1} class="all-head">
        <Show when={list.error()}>
          <label class="error" textWrap={true} text={list.error() ?? ""} />
        </Show>
        <Show when={list.value()}>
          <label class="muted" text={tn(entries().length, "{n} title", "{n} titles")} />
        </Show>
        <Show when={list.value() && !entries().length}>
          <label class="muted mt24" textWrap={true} text={t("Nothing matches these filters.")} />
        </Show>
      </stacklayout>
      <Show
        when={list.value()}
        fallback={
          <wraplayout row={2} class="all-ghosts">
            <For each={Array.from({ length: 12 }, (_, n) => n)}>
              {n => <stacklayout class="ghost grid-cell" width={width} height={height} marginRight={n % 3 === 2 ? 0 : 10} />}
            </For>
          </wraplayout>
        }
      >
        <contentview row={2} ref={(el: ContentView) => (el.content = grid.view)} />
      </Show>
    </gridlayout>
  );
}
