import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { useLocation, useParams, useSearchParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row, VirtualGrid } from "@solidtv/solid/primitives";
import { api, imageUrl } from "../api/client";
import type { SeriesSummary, Title } from "../api/types";
import { ToggleChip } from "../components/Button";
import { Loader } from "../components/Loader";
import { Card } from "../components/Cards";
import { POSTER } from "../components/CardRow";
import { displayText } from "../format";
import { positionsFor } from "../focusMemory";
import {
  browse,
  genresOf,
  indexForLetter,
  letterOf,
  LETTERS,
  type BrowseEntry,
  type SortBy,
} from "../library/browse";
import { focusTopBar, useNavigate } from "../nav";
import { Dropdown } from "../components/Dropdown";
import { Label } from "../components/Label";
import { TopBar } from "../components/TopBar";
import { theme, withAlpha } from "../theme";
import { t, tn } from "../i18n";

const { screen, color, font } = theme;
const GAP = theme.space.block;
/** Opaque: page text draws in its own pass and would show through a translucent panel. */
const RAIL_W = 70;
const GRID_Y = 300;
const CLIP_MARGIN = 24;
const GRID_W = screen.width - screen.gutter * 2 - RAIL_W;
const COLUMNS = Math.floor((GRID_W + GAP) / (POSTER.width + GAP));
const LETTER_H = Math.floor((screen.height - GRID_Y - 20) / LETTERS.length);

type Entry = BrowseEntry & { poster: string | null; progress: number; open: string };

const SORTS: { id: SortBy; label: string }[] = [
  { id: "az", label: "A-Z" },
  { id: "added", label: "Recently added" },
  { id: "rating", label: "Top rated" },
  { id: "year", label: "Newest" },
  { id: "unwatched", label: "Unwatched first" },
];

/** The focus circle is a little larger than a letter's slot, so it reads as a button. */
const RAIL_DOT = 36;

/** What the grid was showing when a title was opened (restored on Back). */
interface GridPosition {
  key: string;
  sort: SortBy;
  genre: string | null;
  only: number | null;
}

function RailLetter(props: { letter: string; enabled: boolean; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={RAIL_W}
      height={LETTER_H}
      skipFocus={!props.enabled}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
      zIndex={focused() ? 2 : 1}
    >
      {/* Centered on the slot (it overhangs the neighbors, drawn above them). */}
      <View
        x={(RAIL_W - RAIL_DOT) / 2}
        y={(LETTER_H - RAIL_DOT) / 2}
        width={RAIL_DOT}
        height={RAIL_DOT}
        borderRadius={RAIL_DOT / 2}
        color={color.focusFill}
        alpha={focused() ? 1 : 0}
        scale={focused() ? 1 : 0.6}
        transition={{ alpha: { duration: 120 }, scale: { duration: 120, easing: "ease-out" } }}
        zIndex={2}
      />
      <Label
        text={props.letter}
        width={RAIL_W}
        height={LETTER_H}
        size={focused() ? 24 : 20}
        color={focused() ? color.focusText : props.enabled ? color.text : withAlpha(color.text, 0x40)}
        zIndex={3}
      />
    </View>
  );
}

/**
 * A whole library as a poster grid with sort/filter chips and an A-Z rail. Virtualized: only
 * the visible rows exist as nodes, and jumping to a letter builds just the rows around it.
 */
export default function Library() {
  const params = useParams<{ id?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [libraries] = createResource(() => api.libraries());
  /** /movies/all and /shows/all: every library of that kind (with the top bar). */
  const byKind = (): "movies" | "shows" | null =>
    location.pathname === "/movies/all" ? "movies" : location.pathname === "/shows/all" ? "shows" : null;
  const library = createMemo(() => libraries()?.find(l => String(l.id) === params.id));
  const kind = () => byKind() ?? library()?.kind;
  /** A main section's grid (Movies, Shows, a library tab): the top bar is on it. */
  const withBar = () => !!byKind() || !!params.id;
  const movies = () => kind() === "movies";
  /** The libraries this page covers, and the one the Library chip narrows it to (null: all). */
  const ofKind = createMemo(() =>
    byKind() ? (libraries() ?? []).filter(l => l.kind === byKind()) : library() ? [library()!] : [],
  );
  // Back from a title: the same list (library, sort, genre) with that title focused.
  const positions = positionsFor(location.pathname + location.search);
  const back = positions.get<GridPosition>("grid");
  const [only, setOnly] = createSignal<number | null>(back?.only ?? null);
  const [libraryMenu, setLibraryMenu] = createSignal(false);
  const source = createMemo(() =>
    kind() && libraries() ? { kind: kind()!, ids: ofKind().map(l => l.id), only: only() } : undefined,
  );
  const heading = () =>
    byKind() ? (byKind() === "movies" ? t("Movies") : t("Shows")) : displayText(library()?.name);

  const [all] = createResource(source, async (src): Promise<Entry[]> => {
    const ids = src.only !== null ? [src.only] : src.ids;
    if (src.kind === "movies") {
      // One library: ask for just it; several: everything, kept to these libraries.
      const titles: Title[] = (await api.titles(ids.length === 1 ? { library_id: ids[0] } : {})).filter(t =>
        ids.includes(t.library_id),
      );
      return titles.map(t => ({
        key: t.id,
        title: t.title,
        year: t.year,
        rating: t.rating,
        genres: t.genres,
        added: t.added_at,
        watched: t.progress?.finished,
        poster: t.poster,
        progress: t.progress && !t.progress.finished ? t.progress.fraction : 0,
        open: `/title/${encodeURIComponent(t.id)}`,
      }));
    }
    const shows: SeriesSummary[] = (await api.series()).filter(s => ids.includes(s.library_id));
    return shows.map(s => ({
      key: s.series,
      title: s.meta_title ?? s.series,
      year: s.year,
      rating: s.rating,
      genres: s.genres,
      added: s.latest_added_at ?? "",
      poster: s.poster,
      progress: 0,
      open: `/series/${encodeURIComponent(s.series)}`,
    }));
  });

  // Finding things: two menus (Sort, Genre; plus Library when there are several) and the A-Z
  // rail. Typing a title is Search's job (it searches the library first).
  const [sort, setSort] = createSignal<SortBy>(back?.sort ?? "az");
  const [sortMenu, setSortMenu] = createSignal(false);
  // Home's genre tiles open a library already filtered (`?genre=Drama`).
  const [search] = useSearchParams();
  const [genre, setGenre] = createSignal<string | null>(
    back ? back.genre : typeof search.genre === "string" && search.genre ? search.genre : null,
  );
  const [genreMenu, setGenreMenu] = createSignal(false);
  const entries = createMemo(() =>
    browse(all() ?? [], { sort: sort(), unwatchedOnly: false, genre: genre() }),
  );
  /** Sorts on offer: "Unwatched first" only where watched state exists (movies). */
  const sorts = () => SORTS.filter(s => s.id !== "unwatched" || movies());
  const sortName = () => t(SORTS.find(s => s.id === sort())?.label ?? "A-Z");
  const genres = createMemo(() => genresOf(all() ?? []));
  const lettersPresent = createMemo(() => new Set(entries().map(e => letterOf(e.title))));
  // The A-Z rail only helps an A-Z list.
  const railVisible = () => sort() === "az" && entries().length > COLUMNS * 2;
  /** Tab pages (Movies, Shows) have no heading: everything moves up into its space. */
  const shift = () => (withBar() ? -70 : 0);
  /** Chips row geometry: each menu drops from under its own chip. */
  const CHIP_W = 300;
  const CHIP_GAP = theme.space.item;
  const chipsY = () => 190 + shift();
  const menuY = () => chipsY() + 48 + 10;
  const chipX = (n: number) => screen.gutter + n * (CHIP_W + CHIP_GAP);

  let grid: ElementNode | undefined;
  let chips: ElementNode | undefined;
  let rail: ElementNode | undefined;
  let genreList: ElementNode | undefined;
  let libraryList: ElementNode | undefined;
  const chooseLibrary = (id: number | null) => {
    setOnly(id);
    setLibraryMenu(false);
    chips?.setFocus();
  };
  let sortList: ElementNode | undefined;
  const chooseSort = (id: SortBy) => {
    setSort(id);
    setSortMenu(false);
    chips?.setFocus();
  };
  const focusGrid = () => (grid ? (grid.setFocus(), true) : false);
  const cursor = () => Number((grid as unknown as { cursor?: number })?.cursor ?? 0);

  const jumpTo = (letter: string) => jumpToIndex(indexForLetter(entries(), letter));
  const jumpToIndex = (i: number) => {
    if (i < 0 || !grid) return;
    // Jump first; the grid rebuilds its visible rows in a microtask, so focus it after that
    // (focusing earlier lands on a stale row position).
    const g = grid;
    (g as unknown as { scrollToIndex: (i: number) => void }).scrollToIndex(i);
    setTimeout(() => g.setFocus(), 0);
  };
  // Restored once the list is in (and the grid built from it).
  if (back) {
    let done = false;
    createEffect(
      on(entries, list => {
        if (done || !list.length) return;
        done = true;
        const i = list.findIndex(e => e.key === back.key);
        if (i > 0) setTimeout(() => jumpToIndex(i), 0);
      }),
    );
  }
  const openRail = () => {
    if (!railVisible() || !rail) return false;
    const current = entries()[cursor()];
    rail.selected = LETTERS.indexOf(current ? letterOf(current.title) : "A");
    rail.setFocus();
    return true;
  };
  const chooseGenre = (g: string | null) => {
    setGenre(g);
    setGenreMenu(false);
    chips?.setFocus();
  };

  const summary = () => {
    const n = entries().length;
    return tn(n, "{n} title", "{n} titles");
  };

  return (
    <View onMenu={withBar() ? focusTopBar : undefined}>
      <Show when={withBar()}>
        <TopBar onDown={() => (chips?.setFocus(), true)} />
      </Show>
      {/* The tab pages (Movies, Shows) are named by the active tab; a single library by name. */}
      <Text x={screen.gutter} y={110} fontSize={font.title} color={color.text} alpha={withBar() ? 0 : 1}>
        {heading() || " "}
      </Text>
      <Text
        x={screen.width - screen.gutter - RAIL_W}
        mountX={1}
        y={withBar() ? 200 + shift() : 130}
        fontSize={font.caption}
        color={color.textMuted}
      >
        {all() ? displayText(summary()) : " "}
      </Text>

      <Show when={all.loading}>
        <Loader x={screen.width / 2} y={GRID_Y + shift() + 300} />
      </Show>

      {/* Sort and filter chips. */}
      <Row
        ref={(el: ElementNode) => (chips = el)}
        x={screen.gutter}
        y={chipsY()}
        width={GRID_W}
        height={48}
        gap={CHIP_GAP}
        scroll="none"
        autofocus={!all()?.length}
        onDown={focusGrid}
        onUp={() => (withBar() ? focusTopBar() : true)}
      >
        <ToggleChip
          label={t("Sort: {name}", { name: sortName() })}
          width={CHIP_W}
          active={sort() !== "az"}
          onSelect={() => {
            setSortMenu(true);
            sortList?.setFocus();
          }}
        />
        <Show when={genres().length > 0}>
          <ToggleChip
            label={t("Genre: {name}", { name: genre() ? displayText(genre()) : t("All") })}
            width={CHIP_W}
            active={!!genre()}
            onSelect={() => {
              setGenreMenu(true);
              genreList?.setFocus();
            }}
          />
        </Show>
        <Show when={ofKind().length > 1}>
          <ToggleChip
            label={t("Library: {name}", {
              name: displayText(ofKind().find(l => l.id === only())?.name ?? t("All")),
            })}
            width={CHIP_W}
            active={only() !== null}
            onSelect={() => {
              setLibraryMenu(true);
              libraryList?.setFocus();
            }}
          />
        </Show>
      </Row>

      {/* Clipped so scrolled-away rows never draw over the title and chips. The margin leaves
          room for the focused card's scale-up. */}
      <View
        y={GRID_Y - CLIP_MARGIN + shift()}
        width={screen.width}
        height={screen.height - GRID_Y + CLIP_MARGIN - shift()}
        clipping
      >
        <Show when={entries().length} fallback={<View />}>
          <VirtualGrid
            ref={(el: ElementNode) => (grid = el)}
            x={screen.gutter}
            y={CLIP_MARGIN}
            width={GRID_W}
            height={screen.height - GRID_Y - shift()}
            columns={COLUMNS}
            // Every row that can be on screen (a partly visible one counts), plus two each way:
            // rows are dropped the moment focus moves, while the scroll is still animating,
            // so a short window shows rows vanishing before they leave the screen.
            rows={Math.ceil((screen.height - GRID_Y - shift()) / (POSTER.height + GAP)) + 1}
            buffer={2}
            gap={GAP}
            scroll="always"
            autofocus
            each={entries()}
            // Up from the top row reaches the chips; Right from the last column, the A-Z rail.
            onUp={() => (cursor() < COLUMNS ? (chips?.setFocus(), true) : false)}
            onRight={() =>
              cursor() % COLUMNS === COLUMNS - 1 || cursor() === entries().length - 1 ? openRail() : false
            }
          >
            {e => (
              <Card
                item={e()}
                width={POSTER.width}
                height={POSTER.height}
                image={imageUrl(e().poster)}
                title={e().title}
                progress={e().progress}
                watched={e().watched}
                onSelect={() => {
                  positions.set("grid", { key: e().key, sort: sort(), genre: genre(), only: only() });
                  navigate(e().open);
                }}
              />
            )}
          </VirtualGrid>
        </Show>
      </View>
      <Show when={all() && !entries().length}>
        <Text x={screen.gutter} y={GRID_Y + shift() + 20} fontSize={font.body} color={color.textMuted}>
          {t("Nothing matches these filters.")}
        </Text>
      </Show>

      {/* A-Z rail (A-Z sort only). Letters without titles are dimmed and skipped. */}
      <View
        x={screen.width - screen.gutter - RAIL_W + 20}
        y={GRID_Y + shift()}
        width={RAIL_W}
        height={LETTERS.length * LETTER_H}
        alpha={railVisible() ? 1 : 0}
        skipFocus={!railVisible()}
      >
        <Column
          ref={(el: ElementNode) => (rail = el)}
          width={RAIL_W}
          gap={0}
          scroll="none"
          onLeft={focusGrid}
          onBack={focusGrid}
          onRight={() => true}
        >
          <For each={LETTERS}>
            {l => <RailLetter letter={l} enabled={lettersPresent().has(l)} onSelect={() => jumpTo(l)} />}
          </For>
        </Column>
      </View>

      {/* Menus for the Sort, Genre and Library chips. */}
      <Dropdown
        x={chipX(0)}
        y={menuY()}
        open={sortMenu()}
        ref={el => (sortList = el)}
        onClose={() => chooseSort(sort())}
        options={sorts().map(o => ({
          label: t(o.label),
          active: sort() === o.id,
          choose: () => chooseSort(o.id),
        }))}
      />
      <Dropdown
        x={chipX(1)}
        y={menuY()}
        open={genreMenu()}
        ref={el => (genreList = el)}
        onClose={() => chooseGenre(genre())}
        options={[
          { label: t("All genres"), active: !genre(), choose: () => chooseGenre(null) },
          ...genres().map(g => ({
            label: displayText(g),
            active: genre() === g,
            choose: () => chooseGenre(g),
          })),
        ]}
      />
      <Dropdown
        x={chipX(genres().length > 0 ? 2 : 1)}
        y={menuY()}
        open={libraryMenu()}
        ref={el => (libraryList = el)}
        onClose={() => chooseLibrary(only())}
        options={[
          { label: t("All libraries"), active: only() === null, choose: () => chooseLibrary(null) },
          ...ofKind().map(l => ({
            label: displayText(l.name),
            active: only() === l.id,
            choose: () => chooseLibrary(l.id),
          })),
        ]}
      />
    </View>
  );
}
