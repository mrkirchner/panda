import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { api, imageUrl } from "../api/client";
import type { Discover, Title } from "../api/types";
import { Backdrop } from "../components/Backdrop";
import { PillButton } from "../components/Button";
import { CardRow } from "../components/CardRow";
import { displayText, longDate, tmdbRating } from "../format";
import { InfoSection, type About } from "../components/InfoSection";
import { Loader } from "../components/Loader";
import type { MetaPart } from "../components/MetaLine";
import { HEADER_H, HeaderArea, PageRows } from "../components/PageRows";
import { PeopleRow } from "../components/PeopleRow";
import { SeasonPicker } from "../components/SeasonPicker";
import { TextSheet } from "../components/TextSheet";
import { TitleHeader } from "../components/TitleHeader";
import { TopBar } from "../components/TopBar";
import { t, tn } from "../i18n";
import { focusTopBar, useNavigate } from "../nav";
import { createDiscoverStatus } from "../discoverStatus";
import { bestProgress } from "../requests";
import { theme } from "../theme";

const { screen, color, font } = theme;
const BUTTONS_Y = HEADER_H - 170;

/** A card in the series row: one of yours (opens it) or one you could request. */
interface MoreItem {
  title?: Title;
  suggestion?: Discover;
}

/** "1h 56m". */
function runtimeText(m: number | null | undefined) {
  return m ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)}h ` : ""}${m % 60}m` : "";
}

/**
 * A title you don't have (from More Like This, Search, a person's page): laid out like one you
 * do, one scrolling page with as much as TMDB tells (logo, ratings, its film series, similar
 * titles, cast, facts), with Request in place of Play. Opens the real page instead when it's
 * in your library after all.
 */
function PreviewView() {
  const params = useParams<{ kind: string; id: string }>();
  const navigate = useNavigate();
  const kind = () => (params.kind === "series" ? "series" : "movie");
  const [item, { refetch }] = createResource(
    () => [kind(), Number(params.id)] as const,
    ([k, id]) => api.preview(k, id),
  );
  // In your library after all: the real page (replacing this one in history).
  createEffect(() => {
    const lib = item()?.library;
    if (!lib) return;
    navigate(
      kind() === "movie" ? `/title/${encodeURIComponent(lib)}` : `/series/${encodeURIComponent(lib)}`,
      { replace: true },
    );
  });

  const [onHeader, setOnHeader] = createSignal(true);
  /** The About card opened in full. */
  const [expanded, setExpanded] = createSignal<About | null>(null);
  const details = () => item()?.details;
  /** Directors (or creators) first, then the top-billed cast. */
  const people = createMemo(() => [...(details()?.directors ?? []), ...(details()?.cast ?? [])]);
  let buttonsRef: ElementNode | undefined;

  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  /** Shows ask which seasons first (when TMDB knows how many). */
  const [choosing, setChoosing] = createSignal(false);
  const request = async (seasons?: number[] | null) => {
    const i = item();
    if (!i?.can_request || sending()) return;
    if (seasons === undefined && i.kind === "series" && (i.seasons ?? 0) > 1) return void setChoosing(true);
    setChoosing(false);
    setSending(true);
    setError("");
    try {
      await api.request(i, seasons);
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const status = createDiscoverStatus();
  /** Your request while nothing has come of it yet (searching, or waiting on the server):
   * it can be cancelled (a title the servers can't find). */
  const cancellable = () => {
    const i = item();
    const r = i ? status.requestFor(i) : undefined;
    if (!r || i!.downloaded) return undefined;
    const p = bestProgress(r);
    return !p || p.state === "searching" ? r : undefined;
  };
  const [cancelling, setCancelling] = createSignal(false);
  const cancel = async () => {
    const r = cancellable();
    if (!r || cancelling()) return;
    setCancelling(true);
    setError("");
    try {
      await api.cancelRequest(r.id);
      status.refresh();
      await refetch();
      buttonsRef?.setFocus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };
  /** Request, or how it's going (Downloading 42%...), like its tile. */
  const label = () => {
    const i = item();
    if (!i) return " ";
    if (sending()) return t("Requesting...");
    return status(i).label ?? t("Not in your library");
  };
  /** "2024 · 1h 56m · PG-13", then the ratings on their own line. */
  const metaParts = (): MetaPart[] => {
    const i = item();
    if (!i) return [];
    const next = i.details.next_episode;
    const ratings = i.details.ratings?.length ? i.details.ratings : tmdbRating(i.rating);
    return [
      i.year?.toString() ?? "",
      i.seasons ? tn(i.seasons, "{n} season", "{n} seasons") : runtimeText(i.runtime_mins),
      i.details.certification ?? "",
      next
        ? t("Next: S{s} E{e}, {date}", {
            s: next.season,
            e: next.episode,
            date: longDate(next.air_date) ?? t("soon"),
          })
        : "",
      ...ratings.slice(0, 3).map(rating => ({ rating })),
    ];
  };
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
      {
        label: kind() === "series" ? t("Created by") : t("Director"),
        names: d.directors.map(p => p.name).join(", "),
      },
    ].filter(c => c.names);
  };
  /** Similar titles, minus the ones the series row already shows. */
  const more = createMemo(() => {
    const inSeries = new Set(
      (item()?.collection?.items ?? []).map(c => c.suggestion?.tmdb_id ?? c.title?.id),
    );
    return (item()?.more ?? []).filter(d => !inSeries.has(d.tmdb_id));
  });
  /** Under Files: not here yet, or how its request is going. */
  const libraryStatus = () => {
    const i = item();
    if (!i) return null;
    if (sending()) return t("Requesting...");
    return i.requested || i.downloaded ? (status(i).label ?? null) : t("Not yet");
  };
  const discoverCard = (d: Discover) => ({
    width: 0,
    height: 0,
    image: imageUrl(d.poster),
    title: d.title,
    badge: status(d).label,
    badgeTone: status(d).tone,
    progress: status(d).progress,
    onSelect: () => navigate(`/discover/${d.kind}/${d.tmdb_id}`),
  });
  const seriesCard = (m: MoreItem) =>
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
      : discoverCard(m.suggestion!);

  return (
    <View>
      <Backdrop src={imageUrl(item()?.backdrop)} dim={!onHeader()} />
      <Show when={item.loading && !item()}>
        <Loader x={screen.width / 2} y={screen.height / 2} />
      </Show>
      <Show when={item.error}>
        <Text x={screen.gutter} y={200} fontSize={font.body} color={color.error}>
          {t("Couldn't load this title.")}
        </Text>
      </Show>
      <Show when={item()}>
        {i => (
          <PageRows onHeaderFocused={setOnHeader} onTopUp={focusTopBar}>
            <HeaderArea visible={onHeader()}>
              <TitleHeader
                ref={el => (buttonsRef = el)}
                title={i().title}
                metaParts={metaParts()}
                logo={imageUrl(i().details.logo) ?? null}
                credits={credits()}
                overview={i().overview}
                buttonsY={BUTTONS_Y}
                autofocus
              >
                <PillButton primary label={label()} width={300} onSelect={() => void request()} />
                <Show when={cancellable()}>
                  <PillButton
                    label={cancelling() ? t("Cancelling...") : t("Cancel request")}
                    width={280}
                    onSelect={() => void cancel()}
                  />
                </Show>
              </TitleHeader>
              <Text
                x={screen.gutter}
                y={BUTTONS_Y + 84}
                fontSize={font.caption}
                color={color.error}
                alpha={error() ? 1 : 0}
              >
                {displayText(error()) || " "}
              </Text>
              <TopBar visible={onHeader()} onDown={() => (buttonsRef?.setFocus(), true)} />
            </HeaderArea>

            {/* One page, scrolled down: the film's series, similar titles, the people, the facts. */}
            <Show when={(i().collection?.items.length ?? 0) > 1}>
              <CardRow<MoreItem>
                title={i().collection!.name}
                items={i().collection!.items.map(c => ({ title: c.title, suggestion: c.suggestion }))}
                card={seriesCard}
              />
            </Show>
            <Show when={more().length > 0}>
              <CardRow<Discover> title={t("More Like This")} items={more()} card={discoverCard} />
            </Show>
            <Show when={people().length > 0}>
              <PeopleRow title={t("Cast & Crew")} people={people()} />
            </Show>
            <InfoSection
              title={i().title}
              genres={i().genres}
              overview={i().overview}
              details={i().details}
              information={
                kind() === "series"
                  ? [
                      { label: t("Network"), value: i().details.studios.join(", ") },
                      { label: t("First aired"), value: longDate(i().details.release_date) },
                      { label: t("Rated"), value: i().details.certification },
                      { label: t("Status"), value: i().details.status },
                      { label: t("Region of origin"), value: i().details.countries?.join(", ") },
                    ]
                  : [
                      { label: t("Studio"), value: i().details.studios.join(", ") },
                      {
                        label: t("Released"),
                        value: longDate(i().details.release_date) ?? i().year?.toString(),
                      },
                      { label: t("Runtime"), value: runtimeText(i().runtime_mins) },
                      { label: t("Rated"), value: i().details.certification },
                      { label: t("Region of origin"), value: i().details.countries?.join(", ") },
                    ]
              }
              files={[
                { label: t("In your library"), value: libraryStatus() },
                {
                  label: t("Seasons"),
                  value: i().seasons ? String(i().seasons) : null,
                },
              ]}
              onExpand={setExpanded}
            />
          </PageRows>
        )}
      </Show>
      <Show when={choosing() && item()}>
        <SeasonPicker
          title={item()!.title}
          seasons={Array.from({ length: item()!.seasons ?? 1 }, (_, i) => i + 1)}
          onRequest={s => void request(s)}
          onCancel={() => {
            setChoosing(false);
            buttonsRef?.setFocus();
          }}
        />
      </Show>
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
    </View>
  );
}

/** Rebuilt for each title (another one opened from here keeps the same route). */
export default function Preview() {
  const params = useParams<{ kind: string; id: string }>();
  return (
    <Show when={`${params.kind}/${params.id}`} keyed>
      <PreviewView />
    </Show>
  );
}
