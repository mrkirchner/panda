// The parts of a movie's, show's, person's or preview page below the header: ratings, round
// action buttons, rows of titles (yours and ones you could request), the cast, and facts.
import { imageUrl } from "@tv/api/client";
import type { Discover, Person, SeriesSummary, Title, TitleRating, TrackInfo } from "@tv/api/types";
import { languageName } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { Poster, Row } from "./cards";
import { openPerson, openPreview, openSeries, openTitle } from "./links";

/** "TMDB 7.8/10  ·  IMDb 8.3/10  ·  RT 91%". */
export function Ratings(props: { ratings: TitleRating[] }) {
  return (
    <Show when={props.ratings.length}>
      <label
        class="facts ratings"
        textWrap={true}
        text={props.ratings
          .slice(0, 4)
          .map(r => `${r.short} ${r.value}`)
          .join("   ·   ")}
      />
    </Show>
  );
}

/** A round button with its name under it (My List, Watched, Versions...). `icon`: SF Symbol. */
export function Action(props: { icon: string; label: string; onTap: () => void; on?: boolean }) {
  return (
    <stacklayout class="action" on:tap={props.onTap}>
      <gridlayout class={props.on ? "action-circle on" : "action-circle"}>
        <image class="action-icon" src={`sys://${props.icon}`} tintColor={props.on ? "#141210" : "#f4f1ea"} />
      </gridlayout>
      <label class="action-label" text={props.label} textWrap={true} />
    </stacklayout>
  );
}

/** One of a "More Like This" or film-series row: yours (opens it) or one you could request. */
export interface MoreItem {
  title?: Title;
  show?: SeriesSummary;
  suggestion?: Discover;
}

export function MoreRow(props: { title: string; items: MoreItem[] }) {
  return (
    <Show when={props.items.length}>
      <Row title={props.title}>
        <For each={props.items}>
          {i =>
            i.title ? (
              <Poster image={i.title.poster} title={i.title.title} onTap={() => openTitle(i.title!.id)} />
            ) : i.show ? (
              <Poster
                image={i.show.poster}
                title={i.show.meta_title ?? i.show.series}
                onTap={() => openSeries(i.show!.series)}
              />
            ) : (
              <Poster
                image={i.suggestion!.poster}
                title={i.suggestion!.title}
                badge={i.suggestion!.requested ? t("Requested") : undefined}
                onTap={() => openPreview(i.suggestion!.kind, i.suggestion!.tmdb_id)}
              />
            )
          }
        </For>
      </Row>
    </Show>
  );
}

/** Cast & Crew: round photos, names and roles; each opens their page. */
export function PeopleRow(props: { people: Person[] }) {
  return (
    <Show when={props.people.length}>
      <Row title={t("Cast & Crew")}>
        <For each={props.people}>
          {p => (
            <stacklayout class="person-cell" on:tap={() => p.id && openPerson(p.id)}>
              <gridlayout class="headshot">
                <label class="headshot-initial" text={p.name.slice(0, 1)} />
                <image class="headshot" src={imageUrl(p.image)} stretch="aspectFill" />
              </gridlayout>
              <label class="person-name" text={p.name} textWrap={true} maxLines={2} />
              <label class="small person-role" text={p.role ?? ""} textWrap={true} maxLines={2} />
            </stacklayout>
          )}
        </For>
      </Row>
    </Show>
  );
}

export interface Fact {
  label: string;
  value: string | null | undefined;
}

/** A heading and its facts (label over value), those without a value left out. */
export function Facts(props: { title: string; facts: Fact[] }) {
  const shown = () => props.facts.filter(f => f.value);
  return (
    <Show when={shown().length}>
      <stacklayout class="facts-block">
        <label class="section-title-text" text={props.title} />
        <For each={shown()}>
          {f => (
            <stacklayout class="fact">
              <label class="small" text={f.label} />
              <label class="body" textWrap={true} text={f.value ?? ""} />
            </stacklayout>
          )}
        </For>
      </stacklayout>
    </Show>
  );
}

/** "English (5.1), Spanish" from a file's tracks (unknown languages left out). */
export function trackList(tracks: TrackInfo[] | undefined): string | null {
  const names = (tracks ?? [])
    .map(tr => {
      const name = languageName(tr.language);
      return name ? (tr.detail ? `${name} (${tr.detail})` : name) : null;
    })
    .filter((n): n is string => !!n);
  return names.length ? [...new Set(names)].join(", ") : null;
}
