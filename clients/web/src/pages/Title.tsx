// A movie, laid out like the TV's (one scrolling page): its backdrop (and clip), logo or name,
// facts and ratings, Play or Resume (and From start), My List / Watched / Versions, credits on the
// side; then its film series, More Like This, Cast & Crew, and About, Information, Languages and
// Files.
import { useParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import type { Discover, Title } from "@tv/api/types";
import { formatTime, longDate, tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { Show, createMemo } from "solid-js";
import { DetailArt, GhostRow, Logo } from "../components/cards";
import { Icon } from "../components/icons";
import {
  Action,
  Credits,
  Facts,
  MoreRow,
  PeopleRow,
  Ratings,
  trackList,
  type MoreItem,
} from "../components/sections";
import { pick } from "../components/ui";
import { facts, gb, genres, load, refreshAll, runtime } from "../data";
import { myListToggle } from "../myList";
import { play, resumeAt } from "../player/launch";

function TitleView(props: { id: string }) {
  const id = props.id;
  const data = load(() => api.title(id), { live: true });
  const details = load(() => api.titleDetails(id).catch(() => null));
  const related = load(() => api.relatedTitles(id).catch(() => [] as Title[]));
  const collection = load(() => api.titleCollection(id).catch(() => null));
  const suggestions = load(() => api.titleSuggestions(id).catch(() => [] as Discover[]));
  const myList = myListToggle("title", id);

  const title = () => data.value();
  const at = () => (title() ? resumeAt(title()!) : 0);
  const start = (from: number, version?: number) => play({ kind: "title", id, version }, from);

  /** More Like This: yours first, then ones you could request; not the films in its series' row. */
  const more = createMemo<MoreItem[]>(() => {
    const inSeries = new Set(
      (collection.value()?.items ?? []).map((i) => i.title?.id ?? `m${i.suggestion?.tmdb_id ?? ""}`),
    );
    return [
      ...(related.value() ?? []).filter((r) => !inSeries.has(r.id)).map((r) => ({ title: r })),
      ...(suggestions.value() ?? [])
        .filter((s) => !inSeries.has(`m${s.tmdb_id}`))
        .map((s) => ({ suggestion: s })),
    ];
  });

  const toggleWatched = async () => {
    const tt = title();
    if (!tt) return;
    await api.watched(tt.versions[0].item_id, !tt.progress?.finished).catch(() => {});
    refreshAll();
  };
  const chooseVersion = async (e: MouseEvent) => {
    const versions = title()?.versions ?? [];
    const i = await pick(
      t("Versions"),
      versions.map((v) => ({ label: `${v.label}  ·  ${gb(v.size_bytes)}` })),
      e.currentTarget as Element,
    );
    if (i >= 0) start(at(), versions[i].item_id);
  };
  const progressText = () =>
    at() > 0 ? t("{t} watched", { t: formatTime(at()) }) : title()?.progress?.finished ? t("Watched") : "";
  const minutes = () =>
    details.value()?.runtime_mins ??
    (title()?.duration_secs ? Math.round(title()!.duration_secs! / 60) : null);

  return (
    <>
      <Show when={data.error()}>
        <p class="empty error page-top">{data.error()}</p>
      </Show>
      <Show
        when={title()}
        fallback={
          <Show when={!data.error()}>
            <div class="ghost ghost-hero" />
            <GhostRow />
          </Show>
        }
      >
        {(tt) => (
          <>
            <section class="detail-hero">
              <DetailArt image={tt().backdrop} clip={{ kind: "title", id }} />
              <div class="detail-body">
                <div class="detail-main">
                  <Show when={details.value()?.logo} fallback={<h1 class="detail-title">{tt().title}</h1>}>
                    <Logo image={details.value()!.logo} title={tt().title} />
                  </Show>
                  <span class="facts-line">
                    {facts([
                      tt().year,
                      runtime(tt().duration_secs),
                      details.value()?.certification,
                      genres(tt().genres, 3),
                    ])}
                  </span>
                  <Ratings
                    ratings={
                      details.value()?.ratings?.length ? details.value()!.ratings! : tmdbRating(tt().rating)
                    }
                  />
                  <Show when={progressText()}>
                    <span class="status-line">{progressText()}</span>
                  </Show>
                  <Show when={details.value()?.tagline}>
                    <p class="tagline">{details.value()!.tagline}</p>
                  </Show>
                  <p class="overview clamp">{tt().overview ?? ""}</p>
                  <div class="actions">
                    <button class="btn primary" onClick={() => start(at())}>
                      <Icon name="play" size={20} />
                      {at() > 0 ? t("Resume") : t("Play")}
                    </button>
                    <Show when={at() > 0}>
                      <button class="btn glass" onClick={() => start(0)}>
                        {t("From start")}
                      </button>
                    </Show>
                    <Action
                      icon={myList.inList() ? "check" : "plus"}
                      label={myList.inList() ? t("In My List") : t("My List")}
                      on={myList.inList()}
                      onClick={() => void myList.toggle()}
                    />
                    <Action
                      icon={tt().progress?.finished ? "eyeOff" : "eye"}
                      label={tt().progress?.finished ? t("Mark unwatched") : t("Mark watched")}
                      onClick={() => void toggleWatched()}
                    />
                    <Show when={tt().versions.length > 1}>
                      <Action icon="stack" label={t("Versions")} onClick={(e) => void chooseVersion(e)} />
                    </Show>
                  </div>
                </div>
                <Show when={details.value()}>
                  {(d) => <Credits cast={d().cast} directors={d().directors} />}
                </Show>
              </div>
            </section>
            <Show when={(collection.value()?.items.length ?? 0) > 1}>
              <MoreRow
                title={collection.value()!.name}
                items={collection.value()!.items.map((i) => ({ title: i.title, suggestion: i.suggestion }))}
              />
            </Show>
            {/* Held by a ghost until every list is in (the TV's). */}
            <Show
              when={related.value() && suggestions.value() && collection.value() !== undefined}
              fallback={<GhostRow />}
            >
              <MoreRow title={t("More Like This")} items={more()} />
            </Show>
            <Show when={details.value() === undefined}>
              <GhostRow />
            </Show>
            <PeopleRow people={[...(details.value()?.directors ?? []), ...(details.value()?.cast ?? [])]} />
            <div class="section facts-grid">
              <Facts title={t("About")} facts={[{ label: tt().title, value: tt().overview }]} />
              <Facts
                title={t("Information")}
                facts={[
                  { label: t("Studio"), value: details.value()?.studios.join(", ") },
                  {
                    label: t("Released"),
                    value: longDate(details.value()?.release_date) ?? tt().year?.toString(),
                  },
                  { label: t("Runtime"), value: minutes() ? runtime(minutes()! * 60) : null },
                  { label: t("Rated"), value: details.value()?.certification },
                  { label: t("Region of origin"), value: details.value()?.countries?.join(", ") },
                ]}
              />
              <Facts
                title={t("Languages")}
                facts={[
                  {
                    label: t("Original language"),
                    value: details.value()?.original_language
                      ? trackList([{ language: details.value()!.original_language!, detail: null }])
                      : null,
                  },
                  ...(details.value()?.version_languages?.length
                    ? details.value()!.version_languages!.flatMap((v) => [
                        { label: `${t("Audio")} · ${v.label}`, value: trackList(v.audio) },
                        { label: `${t("Subtitles")} · ${v.label}`, value: trackList(v.subtitles) },
                      ])
                    : [
                        { label: t("Audio"), value: trackList(details.value()?.audio) },
                        { label: t("Subtitles"), value: trackList(details.value()?.subtitles) },
                      ]),
                ]}
              />
              <Facts
                title={t("Files")}
                facts={[
                  {
                    label: t("Versions"),
                    value: tt()
                      .versions.map((v) => `${v.label} (${gb(v.size_bytes)})`)
                      .join(", "),
                  },
                ]}
              />
            </div>
          </>
        )}
      </Show>
    </>
  );
}

export default function TitlePage() {
  const params = useParams<{ id: string }>();
  return (
    <Show when={params.id} keyed>
      {(id) => <TitleView id={id} />}
    </Show>
  );
}
