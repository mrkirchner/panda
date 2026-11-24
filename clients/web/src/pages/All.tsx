// Every movie or show, as the TV's library grid (Library.tsx): posters with their progress,
// sorted and filtered with the TV's own rules (`@tv/library/browse`: A-Z ignoring "The",
// Recently added, Top rated, Newest, Unwatched first; a genre; unwatched only; one library when
// there are several of the kind; words typed), an A-Z rail, and the count. The grid is virtual:
// only the rows near the screen exist. Choices live in the address, so Back and reload keep them.
import { useSearchParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import { t, tn } from "@tv/i18n";
import {
  LETTERS,
  browse,
  genresOf,
  indexForLetter,
  letterOf,
  type BrowseEntry,
  type SortBy,
} from "@tv/library/browse";
import { For, Show, createMemo, untrack } from "solid-js";
import { Poster } from "../components/cards";
import { VirtualGrid, type GridControls } from "../components/VirtualGrid";
import { Icon } from "../components/icons";
import { pick } from "../components/ui";
import { load } from "../data";
import { libraries } from "../features";
import { href, paths } from "../nav";

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
  href: string;
}

function AllGrid(props: { kind: "movies" | "shows" }) {
  const [params, setParams] = useSearchParams<{
    sort?: string;
    genre?: string;
    library?: string;
    unwatched?: string;
    q?: string;
  }>();
  const libs = load(() => libraries());
  const list = load<Entry[]>(
    async () =>
      props.kind === "movies"
        ? (await api.titles()).map((m) => ({
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
            href: href(paths.title(m.id)),
          }))
        : (await api.series()).map((s) => ({
            key: s.series,
            title: s.meta_title ?? s.series,
            year: s.year,
            rating: s.rating,
            genres: s.genres,
            added: s.latest_added_at ?? "",
            library: s.library_id,
            poster: s.poster,
            progress: 0,
            href: href(paths.series(s.series)),
          })),
    { live: true },
  );
  const sort = () => (SORTS.some((s) => s.id === params.sort) ? (params.sort as SortBy) : "az");
  const genre = () => params.genre ?? null;
  const only = () => (params.library ? Number(params.library) : null);
  const unwatched = () => params.unwatched === "1";
  const ofKind = () => (libs.value() ?? []).filter((l) => l.kind === props.kind);
  const entries = createMemo(() => {
    const all = (list.value() ?? []).filter((e) => only() === null || e.library === only());
    return browse(all, { sort: sort(), unwatchedOnly: unwatched(), genre: genre(), text: params.q ?? "" });
  });
  const genreList = createMemo(() => genresOf(list.value() ?? []));
  const set = (p: Record<string, string | undefined>) => setParams(p, { replace: true });

  const sortMenu = async (e: MouseEvent) => {
    const i = await pick(
      t("Sort"),
      SORTS.map((s) => ({ label: t(s.label), selected: s.id === sort() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ sort: SORTS[i].id === "az" ? undefined : SORTS[i].id });
  };
  const genreMenu = async (e: MouseEvent) => {
    const options = [t("All genres"), ...genreList().map((g) => t(g))];
    const i = await pick(
      t("Genre"),
      options.map((label, n) => ({ label, selected: n === 0 ? !genre() : genreList()[n - 1] === genre() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ genre: i === 0 ? undefined : genreList()[i - 1] });
  };
  const libraryMenu = async (e: MouseEvent) => {
    const options = [
      { label: t("All libraries"), id: null as number | null },
      ...ofKind().map((l) => ({ label: l.name, id: l.id })),
    ];
    const i = await pick(
      t("Library"),
      options.map((o) => ({ label: o.label, selected: o.id === only() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ library: options[i].id === null ? undefined : String(options[i].id) });
  };

  let grid: GridControls | undefined;

  /** The A-Z rail: the first title at or after a letter. */
  const letters = createMemo(() => new Set(entries().map((e) => letterOf(e.title))));
  const jump = (letter: string) => {
    const i = indexForLetter(entries(), letter);
    if (i >= 0) grid?.scrollToIndex(i);
  };

  return (
    <div class="page-top">
      <div class="page-head">
        <h1>{props.kind === "movies" ? t("All movies") : t("All shows")}</h1>
      </div>
      <div class="grid-toolbar">
        <button class={["chip", { on: sort() !== "az" }]} onClick={(e) => void sortMenu(e)}>
          {t("Sort")}: {t(SORTS.find((s) => s.id === sort())!.label)}
          <Icon name="down" size={16} />
        </button>
        <button class={["chip", { on: !!genre() }]} onClick={(e) => void genreMenu(e)}>
          {t("Genre")}: {genre() ? t(genre()!) : t("All")}
          <Icon name="down" size={16} />
        </button>
        <Show when={ofKind().length > 1}>
          <button class={["chip", { on: only() !== null }]} onClick={(e) => void libraryMenu(e)}>
            {t("Library")}: {ofKind().find((l) => l.id === only())?.name ?? t("All")}
            <Icon name="down" size={16} />
          </button>
        </Show>
        <Show when={props.kind === "movies"}>
          <button
            class={["chip", { on: unwatched() }]}
            onClick={() => set({ unwatched: unwatched() ? undefined : "1" })}
          >
            {t("Unwatched")}
          </button>
        </Show>
        <input
          class="input grid-filter"
          type="search"
          placeholder={t("Filter")}
          aria-label={t("Filter")}
          value={untrack(() => params.q) ?? ""}
          onInput={(e) => set({ q: e.currentTarget.value.trim() ? e.currentTarget.value : undefined })}
        />
        <span class="grid-count">
          <Show when={list.value()}>{tn(entries().length, "{n} title", "{n} titles")}</Show>
        </span>
      </div>
      <Show when={list.error()}>
        <p class="empty error">{list.error()}</p>
      </Show>
      <Show when={list.value() && !entries().length}>
        <p class="empty">{t("Nothing matches these filters.")}</p>
      </Show>
      <VirtualGrid
        items={list.value() ? entries() : undefined}
        class={sort() === "az" && entries().length > 40 ? "with-letters" : undefined}
        controls={(c) => (grid = c)}
        cell={(e) => (
          <Poster
            image={e().poster}
            title={e().title}
            fraction={e().progress}
            watched={e().watched}
            href={e().href}
          />
        )}
      />
      <Show when={sort() === "az" && entries().length > 40}>
        <nav class="letters" aria-label={t("Jump to letter")}>
          <For each={LETTERS}>
            {(l) => (
              <button disabled={!letters().has(l)} onClick={() => jump(l)}>
                {l}
              </button>
            )}
          </For>
        </nav>
      </Show>
    </div>
  );
}

export function AllMovies() {
  return <AllGrid kind="movies" />;
}

export function AllShows() {
  return <AllGrid kind="shows" />;
}
