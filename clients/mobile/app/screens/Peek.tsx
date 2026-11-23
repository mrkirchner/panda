// The expanded tile: tapping a poster brings up this sheet, as a focused card expands on the TV
// (backdrop and preview clip, logo, facts, ratings, a few lines about it), with Play or Resume,
// My List and More info (the full page).
import { Dialogs, Screen } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Item, SeriesSummary, Title, TitleDetails } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { Show } from "solid-js";
import { facts, load, runtime } from "../data";
import { myListToggle } from "../myList";
import { leaveSheet } from "../nav";
import { play } from "../player";
import { ClipArt, Logo } from "./cards";
import { openSeries, openTitle } from "./links";
import { Action, Ratings } from "./sections";
import { nextUp } from "./Series";

const failed = (e: unknown) => void Dialogs.alert(e instanceof Error ? e.message : String(e));
const genres = (g: string | null | undefined) => (g ?? "").split(/,\s*/).filter(Boolean).slice(0, 3).join(", ");

export function peekTitle(id: string) {
  const title = load<Title>(() => api.title(id));
  const details = load<TitleDetails | null>(() => api.titleDetails(id).catch(() => null));
  const myList = myListToggle("title", id);
  const resumeAt = () => {
    const p = title.value()?.progress;
    return p && !p.finished && p.position_secs > 30 ? p.position_secs : 0;
  };
  return (
    <Body
      backdrop={title.value()?.backdrop}
      clip={{ kind: "title", id }}
      name={title.value()?.title ?? ""}
      logo={details.value()?.logo ?? null}
      facts={facts([
        title.value()?.year,
        runtime(title.value()?.duration_secs),
        details.value()?.certification,
        genres(title.value()?.genres),
      ])}
      ratings={details.value()?.ratings?.length ? details.value()!.ratings! : tmdbRating(title.value()?.rating)}
      overview={title.value()?.overview ?? ""}
      playLabel={resumeAt() > 0 ? t("Resume") : t("Play")}
      play={() => leaveSheet(() => void play({ kind: "title", id }, resumeAt()).catch(failed))}
      info={() => leaveSheet(() => openTitle(id))}
      inList={myList.inList()}
      toggleList={() => void myList.toggle()}
    />
  );
}

export function peekSeries(name: string) {
  const show = load<SeriesSummary | null>(async () => (await api.series()).find(s => s.series === name) ?? null);
  const details = load<TitleDetails | null>(() => api.seriesDetails(name).catch(() => null));
  const episodes = load<Item[]>(async () =>
    (await api.items({ series: name, kind: "episode", limit: 10000 })).sort(
      (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
    ),
  );
  const myList = myListToggle("series", name);
  const next = () => nextUp(episodes.value() ?? []);
  const label = () => {
    const e = next();
    if (!e) return t("Play");
    const resume = e.progress && !e.progress.finished;
    return `${resume ? t("Resume") : t("Play")} S${e.season ?? 0}:E${e.episode ?? 0}`;
  };
  return (
    <Body
      backdrop={show.value()?.backdrop}
      clip={{ kind: "series", name }}
      name={show.value()?.meta_title ?? name}
      logo={details.value()?.logo ?? null}
      facts={facts([
        show.value()?.year,
        show.value() ? t("{n} seasons", { n: show.value()!.seasons }) : null,
        details.value()?.certification,
        genres(show.value()?.genres),
      ])}
      ratings={details.value()?.ratings?.length ? details.value()!.ratings! : tmdbRating(show.value()?.rating)}
      overview={show.value()?.overview ?? ""}
      playLabel={label()}
      play={() =>
        leaveSheet(() => {
          const e = next();
          if (!e) return openSeries(name);
          const p = e.progress;
          void play({ kind: "item", id: e.id }, p && !p.finished ? p.position_secs : 0).catch(failed);
        })
      }
      info={() => leaveSheet(() => openSeries(name))}
      inList={myList.inList()}
      toggleList={() => void myList.toggle()}
    />
  );
}

function Body(props: {
  backdrop: string | null | undefined;
  clip: { kind: "title"; id: string } | { kind: "series"; name: string };
  name: string;
  logo: string | null;
  facts: string;
  ratings: import("@tv/api/types").TitleRating[];
  overview: string;
  playLabel: string;
  play: () => void;
  info: () => void;
  inList: boolean;
  toggleList: () => void;
}) {
  return (
    <scrollview>
      <stacklayout class="peek">
        <ClipArt image={props.backdrop} clip={props.clip} inSheet={true} />
        <stacklayout class="form">
          <Show when={props.logo} fallback={<label class="h1" textWrap={true} text={props.name} />}>
            <Logo image={props.logo} height={64} maxWidth={Screen.mainScreen.widthDIPs * 0.7} />
          </Show>
          <label class="facts" textWrap={true} text={props.facts} />
          <Ratings ratings={props.ratings} />
          <label class="overview" textWrap={true} maxLines={4} text={props.overview} />
          <button class="primary" text={props.playLabel} on:tap={props.play} />
          <stacklayout orientation="horizontal" class="actions">
            <Action
              icon={props.inList ? "checkmark" : "plus"}
              label={props.inList ? t("In My List") : t("My List")}
              on={props.inList}
              onTap={props.toggleList}
            />
            <Action icon="info.circle" label={t("More info")} onTap={props.info} />
          </stacklayout>
        </stacklayout>
      </stacklayout>
    </scrollview>
  );
}
