// Every movie or show, as the TV's library grid (Library.tsx): posters with their progress,
// sorted and filtered with the TV's own rules (`@tv/library/browse`: A-Z ignoring "The",
// Recently added, Top rated, Newest, Unwatched first; a genre; unwatched only; one library when
// there are several of the kind; words typed), an A-Z rail, and the count. The grid is virtual:
// only the rows near the screen exist. Choices live in the address, so Back and reload keep them.
import { useSearchParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import { t, tn } from "@tv/i18n";
import { LETTERS, browse, genresOf, indexForLetter, letterOf, type BrowseEntry, type SortBy } from "@tv/library/browse";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Poster } from "../components/cards";
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

/** Rows drawn above and below the screen. */
const BUFFER_ROWS = 3;

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
            href: href(paths.title(m.id)),
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
            href: href(paths.series(s.series)),
          })),
    { live: true },
  );
  const sort = () => (SORTS.some(s => s.id === params.sort) ? (params.sort as SortBy) : "az");
  const genre = () => params.genre ?? null;
  const only = () => (params.library ? Number(params.library) : null);
  const unwatched = () => params.unwatched === "1";
  const ofKind = () => (libs.value() ?? []).filter(l => l.kind === props.kind);
  const entries = createMemo(() => {
    const all = (list.value() ?? []).filter(e => only() === null || e.library === only());
    return browse(all, { sort: sort(), unwatchedOnly: unwatched(), genre: genre(), text: params.q ?? "" });
  });
  const genreList = createMemo(() => genresOf(list.value() ?? []));
  const set = (p: Record<string, string | undefined>) => setParams(p, { replace: true });

  const sortMenu = async (e: MouseEvent) => {
    const i = await pick(
      t("Sort"),
      SORTS.map(s => ({ label: t(s.label), selected: s.id === sort() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ sort: SORTS[i].id === "az" ? undefined : SORTS[i].id });
  };
  const genreMenu = async (e: MouseEvent) => {
    const options = [t("All genres"), ...genreList().map(g => t(g))];
    const i = await pick(
      t("Genre"),
      options.map((label, n) => ({ label, selected: n === 0 ? !genre() : genreList()[n - 1] === genre() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ genre: i === 0 ? undefined : genreList()[i - 1] });
  };
  const libraryMenu = async (e: MouseEvent) => {
    const options = [{ label: t("All libraries"), id: null as number | null }, ...ofKind().map(l => ({ label: l.name, id: l.id }))];
    const i = await pick(
      t("Library"),
      options.map(o => ({ label: o.label, selected: o.id === only() })),
      e.currentTarget as Element,
    );
    if (i >= 0) set({ library: options[i].id === null ? undefined : String(options[i].id) });
  };

  // ---- The virtual grid ----
  let grid: HTMLDivElement | undefined;
  const [cols, setCols] = createSignal(3);
  const [rowH, setRowH] = createSignal(240);
  const [range, setRange] = createSignal<[number, number]>([0, 6]);
  const rowCount = () => Math.ceil(entries().length / cols());
  const measure = () => {
    if (!grid) return;
    const style = getComputedStyle(grid);
    const gap = parseFloat(style.getPropertyValue("--gap")) || 12;
    const minW = parseFloat(style.getPropertyValue("--poster-w")) || 140;
    const width = grid.clientWidth;
    const n = Math.max(2, Math.floor((width + gap) / (minW + gap)));
    const cellW = (width - gap * (n - 1)) / n;
    setCols(n);
    setRowH(Math.round(cellW * 1.5 + gap));
    update();
  };
  const update = () => {
    if (!grid) return;
    const top = grid.getBoundingClientRect().top;
    const h = rowH();
    const first = Math.max(0, Math.floor(-top / h) - BUFFER_ROWS);
    const last = Math.ceil((window.innerHeight - top) / h) + BUFFER_ROWS;
    const [a, b] = range();
    if (a !== first || b !== last) setRange([first, last]);
  };
  onSettled(() => {
    const ro = new ResizeObserver(measure);
    if (grid) ro.observe(grid);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update);
    };
  });
  const rows = createMemo(() => {
    const [a, b] = range();
    const out: number[] = [];
    for (let r = a; r < Math.min(b, rowCount()); r++) out.push(r);
    return out;
  });
  const cells = (r: number) => entries().slice(r * cols(), (r + 1) * cols());

  /** The A-Z rail: the first title at or after a letter. */
  const letters = createMemo(() => new Set(entries().map(e => letterOf(e.title))));
  const jump = (letter: string) => {
    const i = indexForLetter(entries(), letter);
    if (i < 0 || !grid) return;
    const y = grid.getBoundingClientRect().top + window.scrollY + Math.floor(i / cols()) * rowH();
    window.scrollTo({ top: y - 120, behavior: "smooth" });
  };

  return (
    <div style={{ "padding-top": "calc(var(--topbar-h) + 8px)" }}>
      <div class="page-head">
        <h1>{props.kind === "movies" ? t("All movies") : t("All shows")}</h1>
      </div>
      <div class="grid-toolbar">
        <button class={["chip", { on: sort() !== "az" }]} onClick={e => void sortMenu(e)}>
          {t("Sort")}: {t(SORTS.find(s => s.id === sort())!.label)}
          <Icon name="down" size={16} />
        </button>
        <button class={["chip", { on: !!genre() }]} onClick={e => void genreMenu(e)}>
          {t("Genre")}: {genre() ? t(genre()!) : t("All")}
          <Icon name="down" size={16} />
        </button>
        <Show when={ofKind().length > 1}>
          <button class={["chip", { on: only() !== null }]} onClick={e => void libraryMenu(e)}>
            {t("Library")}: {ofKind().find(l => l.id === only())?.name ?? t("All")}
            <Icon name="down" size={16} />
          </button>
        </Show>
        <Show when={props.kind === "movies"}>
          <button class={["chip", { on: unwatched() }]} onClick={() => set({ unwatched: unwatched() ? undefined : "1" })}>
            {t("Unwatched")}
          </button>
        </Show>
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
      <div
        class={["vgrid", { "with-letters": sort() === "az" && entries().length > 40 }]}
        ref={el => (grid = el)}
        style={{ height: list.value() ? `${rowCount() * rowH()}px` : "auto" }}
      >
        <Show
          when={list.value()}
          fallback={
            <div class="vgrid-row" style={{ position: "static", "grid-template-columns": `repeat(${cols()}, 1fr)` }}>
              <For each={Array.from({ length: cols() * 3 }, (_, n) => n)}>
                {() => <div class="ghost" style={{ "aspect-ratio": "2 / 3" }} />}
              </For>
            </div>
          }
        >
          <For each={rows()} keyed={false}>
            {r => (
              <div
                class="vgrid-row"
                style={{ top: `${r() * rowH()}px`, "grid-template-columns": `repeat(${cols()}, 1fr)` }}
              >
                <For each={cells(r())} keyed={false}>
                  {e => (
                    <Poster
                      image={e().poster}
                      title={e().title}
                      fraction={e().progress}
                      watched={e().watched}
                      href={e().href}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={sort() === "az" && entries().length > 40}>
        <nav class="letters" aria-label={t("Jump to letter")}>
          <For each={LETTERS}>
            {l => (
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
