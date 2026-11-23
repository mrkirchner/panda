// A movie, laid out like the TV's (one scrolling page): its backdrop, logo or name, facts and
// ratings, Play or Resume, My List / Watched / Versions, then its film series, More Like This,
// Cast & Crew, and About, Information, Languages and Files.
import { Dialogs } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Discover, Title } from "@tv/api/types";
import { formatTime, tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { Show, createMemo } from "solid-js";
import { facts, gb, load, longDate, runtime } from "../data";
import { myListToggle } from "../myList";
import { play } from "../player";
import { Action, Facts, MoreRow, PeopleRow, Ratings, trackList, type MoreItem } from "./sections";
import { ClipArt } from "./cards";

export function titleScreen(id: string) {
  const data = load(() => api.title(id));
  const details = load(() => api.titleDetails(id).catch(() => null));
  const related = load(() => api.relatedTitles(id).catch(() => [] as Title[]));
  const collection = load(() => api.titleCollection(id).catch(() => null));
  const suggestions = load(() => api.titleSuggestions(id).catch(() => [] as Discover[]));
  const myList = myListToggle("title", id);

  const title = () => data.value();
  const resumeAt = () => {
    const p = title()?.progress;
    return p && !p.finished && p.position_secs > 30 ? p.position_secs : 0;
  };
  const start = (at: number, version?: number) =>
    play({ kind: "title", id, version }, at).then(
      () => setTimeout(data.reload, 1500),
      e => void Dialogs.alert(String(e instanceof Error ? e.message : e)),
    );

  /** More Like This: yours first, then ones you could request; not the films in its series' row. */
  const more = createMemo<MoreItem[]>(() => {
    const inSeries = new Set(
      (collection.value()?.items ?? []).map(i => i.title?.id ?? `m${i.suggestion?.tmdb_id ?? ""}`),
    );
    return [
      ...(related.value() ?? []).filter(r => !inSeries.has(r.id)).map(r => ({ title: r })),
      ...(suggestions.value() ?? []).filter(s => !inSeries.has(`m${s.tmdb_id}`)).map(s => ({ suggestion: s })),
    ];
  });

  const toggleWatched = async () => {
    const tt = title();
    if (!tt) return;
    await api.watched(tt.versions[0].item_id, !tt.progress?.finished).catch(() => {});
    data.reload();
  };
  const chooseVersion = async () => {
    const versions = title()?.versions ?? [];
    const labels = versions.map(v => `${v.label}  ·  ${gb(v.size_bytes)}`);
    const picked = await Dialogs.action({ title: t("Versions"), cancelButtonText: t("Cancel"), actions: labels });
    const i = labels.indexOf(picked);
    if (i >= 0) void start(resumeAt(), versions[i].item_id);
  };
  const progressText = () =>
    resumeAt() > 0 ? t("{t} watched", { t: formatTime(resumeAt()) }) : title()?.progress?.finished ? t("Watched") : "";
  const minutes = () => details.value()?.runtime_mins ?? (title()?.duration_secs ? Math.round(title()!.duration_secs! / 60) : null);

  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <Show when={title()}>
          <ClipArt image={title()!.backdrop} clip={{ kind: "title", id }} />
          <stacklayout class="form">
            <Show
              when={details.value()?.logo}
              fallback={<label class="h1" textWrap={true} text={title()!.title} />}
            >
              <image class="logo" src={imageUrl(details.value()!.logo)} stretch="aspectFit" />
            </Show>
            <label
              class="facts"
              textWrap={true}
              text={facts([
                title()!.year,
                runtime(title()!.duration_secs),
                details.value()?.certification,
                (title()!.genres ?? "").split(/,\s*/).slice(0, 3).join(", "),
              ])}
            />
            <Ratings ratings={details.value()?.ratings?.length ? details.value()!.ratings! : tmdbRating(title()!.rating)} />
            <Show when={progressText()}>
              <label class="status-line" text={progressText()} />
            </Show>
            <button
              class="primary"
              text={resumeAt() > 0 ? t("Resume") : t("Play")}
              on:tap={() => void start(resumeAt())}
            />
            <Show when={resumeAt() > 0}>
              <button class="secondary" text={t("From start")} on:tap={() => void start(0)} />
            </Show>
            <stacklayout orientation="horizontal" class="actions">
              <Action
                icon={myList.inList() ? "checkmark" : "plus"}
                label={myList.inList() ? t("In My List") : t("My List")}
                on={myList.inList()}
                onTap={() => void myList.toggle()}
              />
              <Action
                icon={title()!.progress?.finished ? "eye.fill" : "eye"}
                label={title()!.progress?.finished ? t("Mark unwatched") : t("Mark watched")}
                onTap={() => void toggleWatched()}
              />
              <Show when={title()!.versions.length > 1}>
                <Action icon="square.stack" label={t("Versions")} onTap={() => void chooseVersion()} />
              </Show>
            </stacklayout>
            <Show when={details.value()?.tagline}>
              <label class="body accent mt24" textWrap={true} text={details.value()!.tagline ?? ""} />
            </Show>
            <label class="overview" textWrap={true} text={title()!.overview ?? ""} />
            <Show when={details.value()}>
              <label
                class="credits-line"
                textWrap={true}
                text={[
                  details.value()!.cast.length
                    ? `${t("Starring")}: ${details.value()!.cast.slice(0, 3).map(p => p.name).join(", ")}`
                    : "",
                  details.value()!.directors.length
                    ? `${t("Director")}: ${details.value()!.directors.map(p => p.name).join(", ")}`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            </Show>
          </stacklayout>
          <Show when={(collection.value()?.items.length ?? 0) > 1}>
            <MoreRow
              title={collection.value()!.name}
              items={collection.value()!.items.map(i => ({ title: i.title, suggestion: i.suggestion }))}
            />
          </Show>
          <MoreRow title={t("More Like This")} items={more()} />
          <PeopleRow people={[...(details.value()?.directors ?? []), ...(details.value()?.cast ?? [])]} />
          <Facts
            title={t("Information")}
            facts={[
              { label: t("Studio"), value: details.value()?.studios.join(", ") },
              { label: t("Released"), value: longDate(details.value()?.release_date) ?? title()!.year?.toString() },
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
                value: details.value()?.original_language ? trackList([{ language: details.value()!.original_language!, detail: null }]) : null,
              },
              ...(details.value()?.version_languages?.length
                ? details.value()!.version_languages!.flatMap(v => [
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
                value: title()!.versions.map(v => `${v.label} (${gb(v.size_bytes)})`).join(", "),
              },
            ]}
          />
        </Show>
      </stacklayout>
    </scrollview>
  );
}
