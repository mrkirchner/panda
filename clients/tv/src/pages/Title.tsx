import { useBackdropPreview } from "../playback/preview";
import { createMemo, createResource, createSignal, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { api, imageUrl } from "../api/client";
import type { Discover, Title } from "../api/types";
import { Backdrop } from "../components/Backdrop";
import { PillButton } from "../components/Button";
import { displayText, formatTime, longDate, tmdbRating } from "../format";
import { InfoSection, type About } from "../components/InfoSection";
import { TextSheet } from "../components/TextSheet";
import type { MetaPart } from "../components/MetaLine";
import { TopBar } from "../components/TopBar";
import { focusTopBar, useNavigate } from "../nav";
import { createDiscoverStatus } from "../discoverStatus";
import { HEADER_H, HeaderArea, PageRows } from "../components/PageRows";
import { Dropdown } from "../components/Dropdown";
import { IconButton } from "../components/IconButton";
import { PeopleRow } from "../components/PeopleRow";
import { CardRow, GhostRow } from "../components/CardRow";
import { TitleHeader } from "../components/TitleHeader";
import { createMyListToggle } from "../myList";
import { theme } from "../theme";
import { t, t as tr } from "../i18n";

const { screen, color, font } = theme;

/**
 * Like Home: the backdrop fills the screen with the title, details and buttons low on it, and
 * the tabs peek in at the bottom. Down scrolls the tabs and their content up (header fades).
 */
const BUTTONS_Y = HEADER_H - 170;

/** A More Like This entry: one of yours, or one you could request. */
interface MoreItem {
  title?: Title;
  suggestion?: Discover;
}

/** A title's length in minutes, from its file. */
const minutes = (t: Title) => (t.duration_secs ? Math.round(t.duration_secs / 60) : null);
/** "1h 56m". */
function runtimeText(m: number | null | undefined) {
  return m ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)}h ` : ""}${m % 60}m` : null;
}

function gb(bytes: number) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A movie: details, Play/Resume, a version chooser when there are several files, and
 * "More like this" from the library. */
function TitlePageView() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [title, { refetch }] = createResource(
    () => params.id,
    id => api.title(id),
  );
  const [details] = createResource(
    () => params.id,
    id => api.titleDetails(id).catch(() => undefined),
  );
  /** Directors first, then the top-billed cast. */
  const people = createMemo(() => [...(details()?.directors ?? []), ...(details()?.cast ?? [])]);
  const [related] = createResource(
    () => params.id,
    id => api.relatedTitles(id).catch(() => [] as Title[]),
  );
  const [collection] = createResource(
    () => params.id,
    id => api.titleCollection(id).catch(() => null),
  );
  /** A card for one of yours (opens it) or one you could request (its page). */
  const moreCard = (m: MoreItem) =>
    m.title
      ? {
          width: 0,
          height: 0,
          image: imageUrl(m.title.poster),
          title: m.title.title,
          progress: m.title.progress && !m.title.progress.finished ? m.title.progress.fraction : 0,
          watched: m.title.progress?.finished,
          onSelect: () => navigate(`/title/${encodeURIComponent(m.title!.id)}`),
        }
      : {
          width: 0,
          height: 0,
          image: imageUrl(m.suggestion!.poster),
          title: m.suggestion!.title,
          badge: status(m.suggestion!).label,
          badgeTone: status(m.suggestion!).tone,
          progress: status(m.suggestion!).progress,
          onSelect: () => navigate(`/discover/movie/${m.suggestion!.tmdb_id}`),
        };
  const [onHeader, setOnHeader] = createSignal(true);
  // The title's preview clip behind the header after a moment there (stops on scrolling down).
  const video = useBackdropPreview(() => (params.id ? { kind: "title", id: params.id } : null), onHeader);
  const status = createDiscoverStatus();
  const [suggestions] = createResource(
    () => params.id,
    id => api.titleSuggestions(id).catch(() => [] as Discover[]),
  );
  /** More Like This: your library first, then titles you could request; not the films
   * already in its series' row. */
  const more = createMemo<MoreItem[]>(() => {
    const inSeries = new Set(
      (collection()?.items ?? []).map(i => i.title?.id ?? `m${i.suggestion?.tmdb_id ?? ""}`),
    );
    return [
      ...(related() ?? []).filter(t => !inSeries.has(t.id)).map(title => ({ title })),
      ...(suggestions() ?? [])
        .filter(s => !inSeries.has(`m${s.tmdb_id}`))
        .map(suggestion => ({ suggestion })),
    ];
  });
  const myList = createMyListToggle("title", () => params.id);
  const [versionsOpen, setVersionsOpen] = createSignal(false);
  /** The About card opened in full. */
  const [expanded, setExpanded] = createSignal<About | null>(null);
  let versionsRef: ElementNode | undefined;
  let buttonsRef: ElementNode | undefined;

  const resume = createMemo(() => {
    const p = title()?.progress;
    return p && !p.finished && p.position_secs > 0 ? p.position_secs : 0;
  });
  /** "1993 · 1h 50m · PG-13 · [TMDB] 7.0/10 · [IMDb] 6.8/10 · 1:23:45 watched". */
  const metaParts = (): MetaPart[] => {
    const t = title();
    if (!t) return [];
    const mins = t.duration_secs ? Math.round(t.duration_secs / 60) : 0;
    const runtime = mins ? (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`) : "";
    const progress =
      resume() > 0
        ? tr("{t} watched", { t: formatTime(resume()) })
        : t.progress?.finished
          ? tr("Watched")
          : "";
    const ratings = details()?.ratings?.length ? details()!.ratings! : tmdbRating(t.rating);
    return [
      t.year?.toString() ?? "",
      runtime,
      details()?.certification ?? "",
      ...ratings.slice(0, 3).map(rating => ({ rating })),
      progress,
    ];
  };
  /** Lower right of the header: who's in it and who made it. */
  const credits = () => {
    const d = details();
    if (!d) return [];
    return [
      {
        label: t("Starring"),
        names: d.cast
          .slice(0, 3)
          .map(p => p.name)
          .join(", "),
      },
      { label: t("Director"), names: d.directors.map(p => p.name).join(", ") },
    ].filter(c => c.names);
  };
  const play = (start: number, version?: number) =>
    navigate(
      `/play/title/${encodeURIComponent(params.id)}?start=${start}${version ? `&version=${version}` : ""}`,
    );
  const toggleWatched = async () => {
    const t = title();
    if (!t) return;
    await api.watched(t.versions[0].item_id, !t.progress?.finished).catch(() => {});
    void refetch();
  };
  const openVersions = () => {
    setVersionsOpen(true);
    versionsRef?.setFocus();
  };
  const closeVersions = () => {
    setVersionsOpen(false);
    buttonsRef?.setFocus();
    return true;
  };

  return (
    <View>
      <Backdrop src={imageUrl(title()?.backdrop)} dim={!onHeader()} video={video()} />
      <Show when={title.error}>
        <Text x={screen.gutter} y={200} fontSize={font.body} color={color.error}>
          {`Couldn't load this title: ${title.error?.message ?? ""}`}
        </Text>
      </Show>
      <PageRows onHeaderFocused={setOnHeader} onTopUp={focusTopBar}>
        <HeaderArea visible={onHeader()}>
          <TitleHeader
            ref={el => (buttonsRef = el)}
            title={title()?.title ?? ""}
            metaParts={metaParts()}
            logo={imageUrl(details()?.logo) ?? null}
            credits={credits()}
            overview={title()?.overview}
            buttonsY={BUTTONS_Y}
            autofocus
          >
            <PillButton
              primary
              label={resume() > 0 ? t("Resume") : t("Play")}
              width={260}
              onSelect={() => play(resume())}
            />
            <Show when={resume() > 0}>
              <PillButton label={t("From start")} width={240} onSelect={() => play(0)} />
            </Show>
            {/* Secondary actions as round icons, named under them on focus. */}
            <IconButton
              icon={myList.inList() ? "check" : "plus"}
              size={64}
              label={myList.inList() ? t("In My List") : t("Add to My List")}
              onSelect={() => void myList.toggle()}
            />
            <IconButton
              icon={title()?.progress?.finished ? "watched-on" : "watched"}
              size={64}
              label={title()?.progress?.finished ? t("Mark unwatched") : t("Mark watched")}
              onSelect={() => void toggleWatched()}
            />
            <Show when={(title()?.versions.length ?? 0) > 1}>
              <IconButton icon="versions" size={64} label={t("Versions")} onSelect={openVersions} />
            </Show>
          </TitleHeader>
          {/* Avatar, search and the clock (no tabs on a title page); Up from the buttons. */}
          <TopBar visible={onHeader()} onDown={() => (buttonsRef?.setFocus(), true)} />
        </HeaderArea>

        {/* One page, scrolled down: the film's series, similar titles, the people, the facts. */}
        {/* Rows still loading hold their place as ghost rows, so the page doesn't shift when
            they arrive. The series row is expected until the details say there's none. */}
        <Show
          when={!collection.loading}
          fallback={
            <Show when={details.loading || details()?.collection}>
              <GhostRow />
            </Show>
          }
        >
          <Show when={(collection()?.items.length ?? 0) > 1}>
            <CardRow<MoreItem>
              title={collection()!.name}
              items={(collection()?.items ?? []).map(i => ({ title: i.title, suggestion: i.suggestion }))}
              card={moreCard}
            />
          </Show>
        </Show>
        {/* Built once every list is in (the series' titles are left out of it): the row doesn't
            rebuild well when items are added in front of it later. */}
        <Show when={!related.loading && !suggestions.loading && !collection.loading} fallback={<GhostRow />}>
          <Show when={more().length > 0}>
            <CardRow<MoreItem> title={t("More Like This")} items={more()} card={moreCard} />
          </Show>
        </Show>
        <Show when={people().length > 0}>
          <PeopleRow title={t("Cast & Crew")} people={people()} />
        </Show>
        <Show when={title()}>
          {tt => (
            <InfoSection
              title={tt().title}
              genres={tt().genres}
              overview={tt().overview}
              details={details()}
              information={[
                { label: t("Studio"), value: details()?.studios.join(", ") },
                {
                  label: t("Released"),
                  value: longDate(details()?.release_date) ?? tt().year?.toString(),
                },
                { label: t("Runtime"), value: runtimeText(details()?.runtime_mins ?? minutes(tt())) },
                { label: t("Rated"), value: details()?.certification },
                { label: t("Region of origin"), value: details()?.countries?.join(", ") },
              ]}
              files={[
                {
                  label: t("Versions"),
                  value: tt()
                    .versions.map(v => `${v.label} (${gb(v.size_bytes)})`)
                    .join(", "),
                },
              ]}
              onExpand={setExpanded}
            />
          )}
        </Show>
      </PageRows>
      <Show when={expanded()}>
        {e => (
          <TextSheet
            title={e().title}
            subtitle={e().genres}
            text={e().text}
            onClose={() => {
              const back = e().refocus;
              setExpanded(null);
              back();
            }}
          />
        )}
      </Show>
      {/* Version chooser: drops above the buttons (they sit low on the screen). */}
      <Dropdown
        x={screen.gutter + 560}
        y={BUTTONS_Y - (title()?.versions.length ?? 0) * 60 - 40}
        width={560}
        open={versionsOpen()}
        ref={el => (versionsRef = el)}
        onClose={() => void closeVersions()}
        options={(title()?.versions ?? []).map(v => ({
          label: displayText(`${v.label}  |  ${gb(v.size_bytes)}`),
          active: false,
          choose: () => {
            setVersionsOpen(false);
            play(resume(), v.item_id);
          },
        }))}
      />
    </View>
  );
}

/**
 * Rebuilt for each title: opening another from More Like This keeps the same route, and
 * a reused page would stay scrolled down with the old tab and focus.
 */
export default function TitlePage() {
  const params = useParams<{ id: string }>();
  return (
    <Show when={params.id} keyed>
      <TitlePageView />
    </Show>
  );
}
