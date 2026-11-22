import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { api, ensureSession, imageUrl } from "../api/client";
import type { Discover, DiscoverSet, FindResults, Person, SeriesSummary, Title } from "../api/types";
import { CardRow, GhostRow } from "../components/CardRow";
import { PeopleRow } from "../components/PeopleRow";
import { remembered } from "../api/remember";
import { FocusRing } from "../components/FocusRing";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { startVoiceSearch, voiceSupported } from "../voice";
import { suggest } from "../search/suggest";
import { displayText } from "../format";
import { normalized } from "../text";
import { focusTopBar, useNavigate } from "../nav";
import { createDiscoverStatus } from "../discoverStatus";
import { TopBar } from "../components/TopBar";
import { glassEdge, theme } from "../theme";
import { t, tServer } from "../i18n";

/** For comparing names: no accents, case or extra spaces. */
const fold = (x: string) =>
  normalized(x, "NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** A search result: a library movie or show, or one to request. */
type Hit = { title: Title } | { show: SeriesSummary } | { more: Discover };

const { screen, color, font } = theme;

const BAR_Y = 120;
const BAR_H = 72;
const MIC = 72;
const BAR_W = screen.width - screen.gutter * 2 - MIC - theme.space.item;
const SUGGEST_Y = BAR_Y + BAR_H + theme.space.block;
/** Suggestion chips: a tiny poster, the title and what it is. */
const CHIP_H = 76;
const CHIP_POSTER_W = 40;
const CHIP_TEXT_X = 8 + CHIP_POSTER_W + 16;
/** Results start under the chips (with a clear gap), or right under the bar when there are none. */
const RESULTS_Y = SUGGEST_Y + CHIP_H + theme.space.block;
const RESULTS_Y_NO_CHIPS = SUGGEST_Y + 4;
/** Room above the results window for a focused card to grow into. */
const RESULTS_MARGIN = 20;
/** How long the rows wait for People (TMDB) before showing without them first. */
const PEOPLE_WAIT_MS = 1500;

/** A predicted title, with what to show on its chip. */
interface SuggestItem {
  title: string;
  poster: string | null;
  kind: string;
}
/** The query shown in the bar: the end of it once it's longer than this. */
const BAR_CHARS = 70;
/** Typing settles this long before searching (one request per pause, not per key). */
const SEARCH_DEBOUNCE_MS = 300;

/** A predicted title under the search bar: OK fills it in. */
function Suggestion(props: { item: SuggestItem; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const title = () => displayText(props.item.title);
  const w = () =>
    Math.min(420, CHIP_TEXT_X + 24 + Math.max(title().length * 13, props.item.kind.length * 10));
  const ink = () => (focused() ? color.focusText : color.text);
  return (
    <View
      width={w()}
      height={CHIP_H}
      borderRadius={theme.radius.lg}
      color={focused() ? color.focusFill : theme.glass.thin}
      border={glassEdge(!focused())}
      scale={focused() ? 1.04 : 1}
      transition={{ color: { duration: theme.focus.duration }, scale: { duration: theme.focus.duration } }}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      {/* A tiny poster, or a tinted tile with the initial when there's no artwork. */}
      <View x={8} y={8} width={CHIP_POSTER_W} height={CHIP_H - 16} borderRadius={8} color={color.surface}>
        <Show
          when={props.item.poster}
          fallback={
            <Text
              x={CHIP_POSTER_W / 2}
              y={(CHIP_H - 16) / 2}
              mountX={0.5}
              mountY={0.5}
              lineHeight={28}
              fontSize={28}
              color={color.textMuted}
            >
              {title().slice(0, 1).toUpperCase() || " "}
            </Text>
          }
        >
          <View
            src={imageUrl(props.item.poster)}
            width={CHIP_POSTER_W}
            height={CHIP_H - 16}
            borderRadius={8}
          />
        </Show>
      </View>
      <Text
        x={CHIP_TEXT_X}
        y={13}
        width={w() - CHIP_TEXT_X - 16}
        contain="width"
        maxLines={1}
        lineHeight={28}
        fontSize={font.caption}
        color={ink()}
      >
        {title()}
      </Text>
      <Text
        x={CHIP_TEXT_X}
        y={44}
        lineHeight={20}
        fontSize={18}
        color={focused() ? color.focusText : color.textMuted}
      >
        {props.item.kind}
      </Text>
    </View>
  );
}

/** The search bar: OK opens the keyboard. Shows the end of long queries. */
function SearchBar(props: {
  ref: (el: ElementNode) => void;
  text: string;
  typing: boolean;
  onSelect: () => void;
  onRight: () => boolean;
  onDown: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const shown = () => {
    const t = displayText(props.text);
    return t.length > BAR_CHARS ? `…${t.slice(-BAR_CHARS + 1)}` : t;
  };
  return (
    <View
      ref={props.ref}
      x={screen.gutter}
      y={BAR_Y}
      width={BAR_W}
      height={BAR_H}
      borderRadius={theme.radius.md}
      color={focused() || props.typing ? theme.glass.regular : theme.glass.thin}
      border={glassEdge(true)}
      zIndex={9}
      autofocus
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
      onRight={props.onRight}
      onDown={props.onDown}
      onUp={focusTopBar}
    >
      <View
        src="images/icons/search.svg"
        x={28}
        y={(BAR_H - 32) / 2}
        width={32}
        height={32}
        color={color.textMuted}
      />
      <Text
        x={80}
        // Centered on the bar like the icon (mount 0.5; SDF text can't center vertically).
        y={BAR_H / 2 + font.body * 0.06}
        mountY={0.5}
        lineHeight={font.body}
        width={BAR_W - 110}
        contain="width"
        maxLines={1}
        fontSize={font.body}
        color={props.text ? color.text : color.textMuted}
      >
        {props.text ? `${shown()}${props.typing ? "_" : ""}` : t("Search movies and shows")}
      </Text>
      <FocusRing width={BAR_W} height={BAR_H} radius={theme.radius.md} visible={focused()} />
    </View>
  );
}

/** Round mic button beside the search bar. */
function MicButton(props: {
  ref: (el: ElementNode) => void;
  onSelect: () => void;
  onLeft: () => boolean;
  onDown: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      ref={props.ref}
      x={screen.gutter + BAR_W + theme.space.item}
      y={BAR_Y}
      width={MIC}
      height={MIC}
      borderRadius={MIC / 2}
      color={focused() ? color.focusFill : theme.glass.thin}
      border={glassEdge(!focused())}
      zIndex={9}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
      onLeft={props.onLeft}
      onDown={props.onDown}
      onUp={focusTopBar}
      onRight={() => true}
    >
      <View
        src="images/icons/mic.svg"
        x={(MIC - 34) / 2}
        y={(MIC - 34) / 2}
        width={34}
        height={34}
        color={focused() ? color.focusText : color.text}
      />
      <FocusRing width={MIC} height={MIC} radius={MIC / 2} visible={focused()} />
    </View>
  );
}

/**
 * Search: a bar across the top (OK opens a keyboard sheet; the mic searches by voice), title
 * predictions under it, and live results below (your library first, then
 * titles you don't have, which can be requested). With nothing typed it shows trending titles
 * and what's popular on each streaming service, minus your library.
 */
export default function Search() {
  const navigate = useNavigate();
  void ensureSession().catch(() => {});
  const [query, setQuery] = createSignal("");
  const status = createDiscoverStatus();
  /** A title you don't have opens its own page (details, cast, Request). */
  const openPreview = (d: Discover) => navigate(`/discover/${d.kind}/${d.tmdb_id}`);
  // Opened by voice search (or a link) with words already: search them.
  const [params] = useSearchParams<{ q?: string }>();
  createEffect(
    on(
      () => params.q,
      q => {
        if (q) setQuery(q.toLowerCase().slice(0, 60));
      },
    ),
  );
  let barRef: ElementNode | undefined;
  let micRef: ElementNode | undefined;
  let suggestRef: ElementNode | undefined;
  let keyboardRef: ElementNode | undefined;
  /** The keyboard sheet is up. */
  const [typing, setTyping] = createSignal(false);
  /** Every title in the library (movies and shows), loaded once for predictions. */
  const [catalog] = createResource(async () => {
    const [titles, shows] = await Promise.all([
      api.titles().catch(() => [] as Title[]),
      api.series().catch(() => [] as SeriesSummary[]),
    ]);
    return [
      ...titles.map(m => ({ title: m.title, poster: m.poster, kind: t("Movie") })),
      ...shows.map(s => ({ title: s.meta_title ?? s.series, poster: s.poster, kind: t("Show") })),
    ] as SuggestItem[];
  });
  let resultsRef: ElementNode | undefined;

  // Search once typing settles.
  const [settled, setSettled] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(query, q => {
      clearTimeout(timer);
      timer = setTimeout(() => setSettled(q.trim()), SEARCH_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  useTypedInput({
    enabled: () => true,
    hasText: () => Boolean(query()),
    onType: ch => type(ch),
    onDelete: () => backspace(),
  });

  const source = createMemo(() => (settled() ? { q: settled() } : null));
  // Library matches come back at once; "not in your library" (Radarr/Sonarr lookups, which can
  // take seconds) is a second request that fills in its row when it's ready.
  const [library] = createResource(source, s => api.find({ ...s, more: false }));
  const [extra] = createResource(source, s => api.findMore(s.q).catch(() => ({ more: [] as Discover[] })));
  // People come from TMDB: waited for (briefly) so their row's place is known before rows show.
  const [people] = createResource(source, s =>
    Promise.race([
      api.findPeople(s.q).catch(() => [] as Person[]),
      new Promise<Person[]>(done => setTimeout(() => done([]), PEOPLE_WAIT_MS)),
    ]),
  );
  /** Results to lay out: your library's and People are both back (the order is then fixed). */
  const ready = () => showing() && !!library() && !people.loading;
  const results = Object.assign(
    (): FindResults | undefined => {
      const l = library();
      return l && { ...l, more: extra()?.more ?? [] };
    },
    {
      get loading() {
        return library.loading;
      },
    },
  );
  /** Predictions: library titles, plus titles Radarr/Sonarr found, for what's typed so far. */
  const suggestions = createMemo(() => {
    const q = query().trim();
    if (!q) return [];
    const extra: SuggestItem[] =
      results()?.more.map(d => ({ title: d.title, poster: d.poster, kind: t("Not in your library") })) ?? [];
    const pick = (items: SuggestItem[]) => {
      const byTitle = new Map(items.map(i => [i.title, i]));
      return suggest(
        items.map(i => i.title),
        q,
        5,
      ).map(t => byTitle.get(t)!);
    };
    // Your library first; titles you don't have fill the rest. Only beside your own (known at
    // once): chips arriving later would push the results down.
    const own = pick(catalog() ?? []);
    if (!own.length) return [];
    const more = pick(extra).filter(t => !own.some(o => o.title.toLowerCase() === t.title.toLowerCase()));
    return [...own, ...more].slice(0, 5).filter(s => s.title.toLowerCase() !== q.toLowerCase());
  });
  const resultsY = () => (suggestions().length ? RESULTS_Y : RESULTS_Y_NO_CHIPS);
  /** Popular elsewhere (trending, per streaming service), not in the library: requestable. */
  // From what was last shown (Back shows the rows, and their posters, as they were).
  const sets = remembered("discover", () => api.discover().catch(() => [] as DiscoverSet[]));

  const type = (s: string) => setQuery(q => (q + s).slice(0, 60));
  const backspace = () => setQuery(q => q.slice(0, -1));
  const clear = () => setQuery("");

  const openTitle = (t: Title) => {
    navigate(`/title/${encodeURIComponent(t.id)}`);
  };
  const openShow = (s: SeriesSummary) => {
    navigate(`/series/${encodeURIComponent(s.series)}`);
  };

  const showing = () => source() !== null;
  const r = () => (showing() ? results() : undefined);
  /** The search is someone's name (the best match's starts with it): People comes first. */
  const personFirst = () => {
    const name = people()?.[0]?.name;
    const q = (source()?.q ?? "").trim();
    return !!name && q.length >= 4 && fold(name).startsWith(fold(q));
  };
  /** Movies, then shows: yours first, then ones to request (their badge says so). */
  const movieHits = (): Hit[] => [
    ...(r()?.movies ?? []).map(t => ({ title: t })),
    ...(r()?.more ?? []).filter(d => d.kind === "movie").map(d => ({ more: d })),
  ];
  const showHits = (): Hit[] => [
    ...(r()?.shows ?? []).map(s => ({ show: s })),
    ...(r()?.more ?? []).filter(d => d.kind !== "movie").map(d => ({ more: d })),
  ];
  const hitCard = (h: Hit) => {
    if ("title" in h) {
      const ti = h.title;
      return {
        width: 0,
        height: 0,
        image: imageUrl(ti.poster),
        title: ti.title,
        progress: ti.progress && !ti.progress.finished ? ti.progress.fraction : 0,
        watched: ti.progress?.finished,
        onSelect: () => openTitle(ti),
      };
    }
    if ("show" in h) {
      const sh = h.show;
      return {
        width: 0,
        height: 0,
        image: imageUrl(sh.poster),
        title: sh.meta_title ?? sh.series,
        onSelect: () => openShow(sh),
      };
    }
    const d = h.more;
    return {
      width: 0,
      height: 0,
      image: imageUrl(d.poster),
      title: d.title,
      badge: status(d).label,
      badgeTone: status(d).tone,
      progress: status(d).progress,
      onSelect: () => openPreview(d),
    };
  };
  const nothing = () =>
    showing() &&
    !results.loading &&
    !extra.loading &&
    !people.loading &&
    r() &&
    !r()!.movies.length &&
    !r()!.shows.length &&
    !r()!.more.length &&
    !people()?.length;

  const openKeyboard = () => {
    setTyping(true);
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const closeKeyboard = () => {
    setTyping(false);
    barRef?.setFocus();
    return true;
  };
  const voice = () => startVoiceSearch(text => setQuery(text.toLowerCase()));
  /** Down from the bar: suggestions, else the keyboard if it's up, else the results. */
  const belowBar = () => {
    if (suggestions().length && suggestRef) suggestRef.setFocus();
    else if (typing()) keyboardRef?.setFocus();
    else if (resultsRef?.children.length) resultsRef.setFocus();
    return true;
  };
  /** Up to the row above: suggestions if there are any, else the bar. */
  const aboveResults = () => {
    if (suggestions().length && suggestRef) suggestRef.setFocus();
    else barRef?.setFocus();
    return true;
  };

  return (
    <View onMenu={focusTopBar} onBack={() => (typing() ? closeKeyboard() : false)}>
      {/* Covers the area above the results: text in a scrolled-away row ignores the results
          window's clipping (text draws in its own pass), so it's hidden under this instead.
          The bar, mic and chips sit above it (zIndex 9; the top bar is 10). */}
      <View
        width={screen.width}
        height={resultsY() - RESULTS_MARGIN}
        color={color.background}
        zIndex={8}
        skipFocus
        transition={{ height: { duration: 180, easing: "ease-out" } }}
      />
      <TopBar onDown={() => (barRef?.setFocus(), true)} />
      <SearchBar
        ref={el => (barRef = el)}
        text={query()}
        typing={typing()}
        onSelect={openKeyboard}
        onRight={() => (voiceSupported() ? (micRef?.setFocus(), true) : true)}
        onDown={belowBar}
      />
      <Show when={voiceSupported()}>
        <MicButton
          ref={el => (micRef = el)}
          onSelect={voice}
          onLeft={() => (barRef?.setFocus(), true)}
          onDown={belowBar}
        />
      </Show>

      {/* Predictions: one row of chips under the bar. */}
      <Row
        ref={suggestRef}
        zIndex={9}
        x={screen.gutter}
        y={SUGGEST_Y}
        width={screen.width - screen.gutter * 2}
        height={CHIP_H}
        gap={theme.space.item}
        scroll="none"
        skipFocus={!suggestions().length}
        alpha={suggestions().length ? 1 : 0}
        onUp={() => (barRef?.setFocus(), true)}
        onDown={() => {
          if (typing()) keyboardRef?.setFocus();
          else if (resultsRef?.children.length) resultsRef.setFocus();
          return true;
        }}
      >
        <For each={suggestions()}>
          {s => (
            <Suggestion
              item={s}
              onSelect={() => {
                setQuery(s.title.toLowerCase());
                setTyping(false);
                // Jump straight to the results once they're in.
                setTimeout(
                  () => (resultsRef?.children.length ? resultsRef.setFocus() : barRef?.setFocus()),
                  600,
                );
              }}
            />
          )}
        </For>
      </Row>

      {/* Results (or, with nothing typed, trending and popular-on-service rows). */}
      {/* A fixed window below the chips: the list scrolls inside it and never over the bar.
          The top margin leaves room for a focused card's grow and ring. */}
      <View
        y={resultsY() - RESULTS_MARGIN}
        width={screen.width}
        height={screen.height - resultsY() + RESULTS_MARGIN}
        clipping
        forwardFocus={0}
        transition={{ y: { duration: 180, easing: "ease-out" } }}
      >
        <Column
          ref={resultsRef}
          y={RESULTS_MARGIN}
          width={screen.width}
          height={screen.height - resultsY()}
          gap={30}
          scroll="always"
          onUp={function (this: ElementNode) {
            return (this.selected ?? 0) === 0 ? aboveResults() : false;
          }}
        >
          <Show when={!showing() && sets() === undefined}>
            <GhostRow left={screen.gutter} />
            <GhostRow left={screen.gutter} />
          </Show>
          <Show when={!showing()}>
            <For each={sets() ?? []}>
              {set => (
                <CardRow<Discover>
                  title={tServer(set.title)}
                  left={screen.gutter}
                  items={set.items}
                  card={d => ({
                    width: 0,
                    height: 0,
                    image: imageUrl(d.poster),
                    title: d.title,
                    badge: status(d).label,
                    badgeTone: status(d).tone,
                    progress: status(d).progress,
                    onSelect: () => openPreview(d),
                  })}
                />
              )}
            </For>
          </Show>

          {/* Searches: ghost rows until the library's results and People are back, then each
            row in a fixed place. Movies and Shows keep a ghost while Radarr/Sonarr (a few
            seconds) may still fill them, so nothing moves when they do. */}
          <Show when={showing() && !ready()}>
            <GhostRow left={screen.gutter} />
            <GhostRow left={screen.gutter} />
          </Show>
          <Show when={ready() && personFirst()}>
            <PeopleRow title={t("People")} people={people() ?? []} />
          </Show>
          <Show when={ready() && (movieHits().length > 0 || extra.loading)}>
            <Show when={movieHits().length > 0} fallback={<GhostRow left={screen.gutter} />}>
              <CardRow<Hit> title={t("Movies")} left={screen.gutter} items={movieHits()} card={hitCard} />
            </Show>
          </Show>
          <Show when={ready() && (showHits().length > 0 || extra.loading)}>
            <Show when={showHits().length > 0} fallback={<GhostRow left={screen.gutter} />}>
              <CardRow<Hit> title={t("Shows")} left={screen.gutter} items={showHits()} card={hitCard} />
            </Show>
          </Show>
          <Show when={ready() && (people()?.length ?? 0) > 0 && !personFirst()}>
            <PeopleRow title={t("People")} people={people() ?? []} />
          </Show>
        </Column>
      </View>

      <Text
        x={screen.gutter}
        y={resultsY() + 20}
        fontSize={font.body}
        color={color.textMuted}
        alpha={nothing() ? 1 : 0}
      >
        {t('Nothing found for "{q}"', { q: displayText(settled()) })}
      </Text>

      {/* Keyboard sheet: slides up from the bottom while typing; Close or Back closes it. */}
      <KeyboardSheet
        open={typing()}
        ref={el => (keyboardRef = el)}
        onType={type}
        onDelete={backspace}
        onClear={clear}
        onClose={closeKeyboard}
        value={query()}
        title={t("Search")}
        onTopEdge={() => {
          if (suggestions().length && suggestRef) suggestRef.setFocus();
          else barRef?.setFocus();
          return true;
        }}
      />
    </View>
  );
}
