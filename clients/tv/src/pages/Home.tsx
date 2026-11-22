import { useBackdropPreview, type PreviewSource } from "../playback/preview";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { api, ensureSession, imageUrl } from "../api/client";
import type {
  ContinueEntry,
  Discover,
  Featured,
  GenreTile,
  MyListEntry,
  MyRequest,
  SeriesSummary,
  Spot,
  ThemedRow,
  Title,
} from "../api/types";
import { Backdrop } from "../components/Backdrop";
import { CardRow, GhostRow } from "../components/CardRow";
import { keep, recall, remembered } from "../api/remember";
import { Spotlight } from "../components/Spotlight";
import { HeroCarousel, resumeAt, slideInfo } from "../components/HeroCarousel";
import { HEADER_H, HeaderArea, PageRows } from "../components/PageRows";
import { TopBar } from "../components/TopBar";
import { createDiscoverStatus } from "../discoverStatus";
import { focusTopBar, useNavigate } from "../nav";
import { bestProgress, inFlight, requestBadge } from "../requests";
import { genreTint, theme } from "../theme";
import { logoOf, spotMeta, spotPath, spotReason } from "../spots";
import { t, tn } from "../i18n";

const { screen, color, font } = theme;

/** Servers before the mixed hero sent plain movies; show those as "Recently added" slides. */
const asFeatured = (f: Featured | Title): Featured =>
  "reason" in f ? f : { reason: "Recently added", movie: f };

/** "2007  |  5 seasons  |  Drama, Crime  |  7.5/10" under an open card in the shows row. */
const showMeta = (s: SeriesSummary) =>
  [
    s.year,
    tn(s.seasons, "{n} season", "{n} seasons"),
    s.genres,
    s.rating ? `${s.rating.toFixed(1)}/10` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** "2015  |  Comedy, Drama  |  7.5/10" under an open card in the movies row. */
const movieMeta = (t: Title) =>
  [t.year, t.genres, t.rating ? `${t.rating.toFixed(1)}/10` : null].filter(Boolean).join(" · ");

/** A holiday/themed row's card: one of yours, or one you could request. */
interface ThemedItem {
  spot?: Spot;
  discover?: Discover;
}
const themedItems = (row: ThemedRow): ThemedItem[] => [
  ...row.items.map(spot => ({ spot })),
  ...row.more.map(discover => ({ discover })),
];

/** My List shows your requests (with progress) first, then what you saved. */
interface ListItem {
  request?: MyRequest;
  entry?: MyListEntry;
}

/** While anything is on its way, refresh request progress this often. */
const REQUESTS_POLL_MS = 20_000;

export default function Home() {
  const navigate = useNavigate();
  // Both at once, each starting from what this profile last saw (so Back shows Home as it was,
  // no rows popping in), refreshed quietly.
  const home = remembered("home", () => ensureSession().then(() => api.home()));
  // Genre tiles, feature cards and themed rows: they take longer, never holding up the rest.
  const more = remembered("home-more", () =>
    ensureSession()
      .then(() => api.homeMore())
      .catch(() => null),
  );
  /** Rows still on their way (first visit): ghost rows hold their place. */
  const moreComing = () => more() === undefined && more.loading;
  const spotlight = (i: number) => more()?.spotlights[i];
  // Your requests head My List: remembered like the rows, so coming back shows them at once
  // (arriving later, they'd push the row's cards along under you).
  const [requests, setRequests] = createStore<MyRequest[]>(recall<MyRequest[]>("requests") ?? []);
  let hero: ElementNode | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const loadRequests = async () => {
    const list = await api.myRequests().catch(() => null);
    // `reconcile` keeps each request's object (by id), so tiles update in place without
    // rebuilding the row or moving focus.
    if (list) {
      keep("requests", list);
      setRequests(reconcile(list, { key: "id" }));
    }
    clearTimeout(pollTimer);
    if ((list ?? []).some(inFlight)) pollTimer = setTimeout(() => void loadRequests(), REQUESTS_POLL_MS);
  };
  void ensureSession().then(loadRequests, () => {});
  onCleanup(() => clearTimeout(pollTimer));
  // A request already saved in My List shows once (as the request while it's on its way).
  const myList = createMemo<ListItem[]>(() => {
    // A request that arrived joined My List (server side, once): from then on it's an ordinary
    // saved title, which can be removed like any other.
    const pending = requests.filter(r => !(r.listed && (r.title_id || r.series)));
    const reqs = pending.map(request => ({ request }));
    const shown = new Set(pending.map(r => r.title_id ?? r.series).filter(Boolean));
    const saved = (home()?.my_list ?? []).filter(e => !shown.has(e.id)).map(entry => ({ entry }));
    return [...reqs, ...saved];
  });
  /** Ready ones open like any title; ones on their way open the title's page, which shows how
   * the request is going (Searching, Downloading 42%...). */
  const openRequest = (r: MyRequest) => {
    if (r.title_id) navigate(`/title/${encodeURIComponent(r.title_id)}`);
    else if (r.series) navigate(`/series/${encodeURIComponent(r.series)}`);
    else if (r.tmdb_id) navigate(`/discover/${r.kind}/${r.tmdb_id}`);
  };
  const [onHero, setOnHero] = createSignal(true);
  const [current, setCurrent] = createSignal<Featured | undefined>();
  // The hero's preview clip: after resting on a slide a moment, its clip fades in behind it.
  const previewOf = (f: Featured): PreviewSource =>
    f.movie ? { kind: "title", id: f.movie.id } : { kind: "series", name: f.series!.series };
  const heroVideo = useBackdropPreview(() => {
    const slide = current();
    return slide ? previewOf(slide) : null;
  }, onHero);
  // Without artwork (no TMDB yet) still feature the newest titles rather than an empty hero.
  const featured = createMemo<Featured[]>(() =>
    home()?.featured.length
      ? home()!.featured.map(asFeatured)
      : (home()?.recently_added_movies.slice(0, 5) ?? []).map(movie => ({ reason: "Recently added", movie })),
  );

  const openTitle = (t: Title) => navigate(`/title/${encodeURIComponent(t.id)}`);
  const openSpot = (s: Spot) => navigate(spotPath(s));
  const spotCard = (s: Spot) => ({
    width: 0,
    height: 0,
    image: imageUrl(s.backdrop ?? s.poster),
    logo: logoOf(s),
    title: s.title,
    meta: spotMeta(s),
    reason: spotReason(s),
    onSelect: () => openSpot(s),
  });
  // Requestable titles in themed rows: Request / Requested / Downloading 42%, like Search.
  const discoverStatus = createDiscoverStatus();
  const themedCard = (i: ThemedItem) => {
    if (i.spot) {
      const s = i.spot;
      return { width: 0, height: 0, image: imageUrl(s.poster), title: s.title, onSelect: () => openSpot(s) };
    }
    const d = i.discover!;
    const st = discoverStatus(d);
    return {
      width: 0,
      height: 0,
      image: imageUrl(d.poster),
      title: d.title,
      badge: st.label,
      badgeTone: st.tone,
      progress: st.progress,
      onSelect: () => navigate(`/discover/${d.kind}/${d.tmdb_id}`),
    };
  };
  /** A spotlight banner between rows (when there's one for this slot). */
  const banner = (i: number) => (
    <Show when={spotlight(i)}>
      {s => (
        <Spotlight
          title={s().title}
          backdrop={imageUrl(s().backdrop)}
          logo={logoOf(s())}
          meta={spotMeta(s())}
          reason={spotReason(s())}
          onSelect={() => openSpot(s())}
        />
      )}
    </Show>
  );
  const openSeries = (name: string) => navigate(`/series/${encodeURIComponent(name)}`);
  const playTitle = (t: Title) => navigate(`/play/title/${encodeURIComponent(t.id)}?start=${resumeAt(t)}`);
  /** Hero Play: the movie, or the show's next episode (its page when there's none). */
  const playFeatured = (f: Featured) => {
    if (f.movie) return playTitle(f.movie);
    const n = f.series!.next;
    if (n) navigate(`/play/item/${n.item_id}?start=${n.position_secs}`);
    else openSeries(f.series!.series);
  };
  const infoFeatured = (f: Featured) => (f.movie ? openTitle(f.movie) : openSeries(f.series!.series));
  /** Plays straight away; Back from the player then lands on the title's page (to mark it
   * watched, pick another episode...) rather than Home. */
  const playContinue = (c: ContinueEntry) => {
    const page = c.title_id
      ? `/title/${encodeURIComponent(c.title_id)}`
      : c.series
        ? `/series/${encodeURIComponent(c.series)}`
        : null;
    const back = page ? `&back=${encodeURIComponent(page)}` : "";
    if (c.title_id) navigate(`/play/title/${encodeURIComponent(c.title_id)}?start=${c.position_secs}${back}`);
    else navigate(`/play/item/${c.item_id}?start=${c.up_next ? 0 : c.position_secs}${back}`);
  };

  return (
    <View onMenu={focusTopBar}>
      <Backdrop
        src={imageUrl(current() ? slideInfo(current()!).backdrop : null)}
        hidden={!onHero()}
        video={heroVideo()}
      />
      <Show when={home.error && !home()}>
        <Text x={screen.gutter} y={200} fontSize={font.body} color={color.error}>
          {`Can't reach the Panda server: ${home.error?.message ?? ""}`}
        </Text>
      </Show>
      <PageRows onHeaderFocused={setOnHero} onTopUp={focusTopBar}>
        <HeaderArea visible={onHero()}>
          {/* The hero first: the header forwards focus to its first child. */}
          <View ref={hero} width={screen.width} height={HEADER_H} forwardFocus={0}>
            <HeroCarousel
              slides={featured()}
              active={onHero()}
              hold={heroVideo()}
              placeholder={home.loading && !home() ? " " : "Panda"}
              onCurrent={setCurrent}
              onPlay={playFeatured}
              onInfo={infoFeatured}
            />
          </View>
          <TopBar visible={onHero()} onDown={() => (hero?.setFocus(), true)} />
        </HeaderArea>
        <Show when={(home()?.continue_watching.length ?? 0) > 0}>
          <CardRow<ContinueEntry>
            title={t("Continue Watching")}
            variant="wide"
            items={home()?.continue_watching ?? []}
            card={c => ({
              width: 0,
              height: 0,
              image: imageUrl(c.backdrop ?? c.poster),
              title: c.title,
              subtitle: c.up_next ? `Up next  |  ${c.subtitle}` : c.subtitle,
              progress: c.fraction,
              onSelect: () => playContinue(c),
            })}
          />
        </Show>
        <Show when={myList().length > 0}>
          <CardRow<ListItem>
            title={t("My List")}
            items={myList()}
            card={i =>
              i.request
                ? {
                    width: 0,
                    height: 0,
                    image: imageUrl(i.request.poster),
                    title: i.request.title,
                    badge: requestBadge(i.request)?.label,
                    badgeTone: requestBadge(i.request)?.tone,
                    progress:
                      bestProgress(i.request)?.state === "downloading"
                        ? bestProgress(i.request)!.fraction
                        : 0,
                    onSelect: () => openRequest(i.request!),
                  }
                : {
                    width: 0,
                    height: 0,
                    image: imageUrl(i.entry!.poster),
                    title: i.entry!.title,
                    onSelect: () =>
                      navigate(
                        i.entry!.kind === "title"
                          ? `/title/${encodeURIComponent(i.entry!.id)}`
                          : `/series/${encodeURIComponent(i.entry!.id)}`,
                      ),
                  }
            }
          />
        </Show>
        {/* Holidays in season (Christmas...): timely, so near the top. */}
        <For each={(more()?.themed ?? []).filter(r => r.seasonal)}>
          {row => <CardRow<ThemedItem> title={t(row.title)} items={themedItems(row)} card={themedCard} />}
        </For>
        <CardRow<Title>
          title={t("Recently Added Movies")}
          variant="expand"
          items={home()?.recently_added_movies ?? []}
          card={t => ({
            width: 0,
            height: 0,
            image: imageUrl(t.poster),
            backdrop: imageUrl(t.backdrop),
            meta: movieMeta(t),
            title: t.title,
            preview: { kind: "title", id: t.id },
            progress: t.progress && !t.progress.finished ? t.progress.fraction : 0,
            watched: t.progress?.finished,
            onSelect: () => openTitle(t),
          })}
        />
        <Show when={(more()?.genres.length ?? 0) > 0}>
          <CardRow<GenreTile>
            title={t("Browse by genre")}
            variant="genre"
            items={more()?.genres ?? []}
            card={g => ({
              width: 0,
              height: 0,
              image: imageUrl(g.backdrop),
              title: t(g.name),
              tint: genreTint(g.name),
              onSelect: () => navigate(`/genre/${encodeURIComponent(g.name)}`),
            })}
          />
        </Show>
        <Show when={(home()?.recently_added_shows.length ?? 0) > 0}>
          <CardRow<SeriesSummary>
            title={t("Recently Added Shows")}
            variant="expand"
            items={home()?.recently_added_shows ?? []}
            card={s => ({
              width: 0,
              height: 0,
              image: imageUrl(s.poster),
              backdrop: imageUrl(s.backdrop),
              meta: showMeta(s),
              title: s.meta_title ?? s.series,
              preview: { kind: "series", name: s.series },
              onSelect: () => navigate(`/series/${encodeURIComponent(s.series)}`),
            })}
          />
        </Show>
        <Show when={!home() && home.loading}>
          <GhostRow variant="expand" />
          <GhostRow variant="expand" />
        </Show>
        <Show when={moreComing()}>
          <GhostRow variant="genre" />
          <GhostRow variant="tall" />
        </Show>
        {banner(0)}
        <Show when={(more()?.top_picks.length ?? 0) > 0}>
          <CardRow<Spot>
            title={t("Top picks for you")}
            variant="tall"
            items={more()?.top_picks ?? []}
            card={spotCard}
          />
        </Show>
        {/* Today's themes (Heists, Time travel...): they change daily. */}
        <For each={(more()?.themed ?? []).filter(r => !r.seasonal)}>
          {row => <CardRow<ThemedItem> title={t(row.title)} items={themedItems(row)} card={themedCard} />}
        </For>
      </PageRows>
    </View>
  );
}
