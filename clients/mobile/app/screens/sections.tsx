// The parts of a movie's, show's, person's or preview page below the header: ratings, round
// action buttons, rows of titles (yours and ones you could request), the cast, and facts.
import { imageUrl } from "@tv/api/client";
import type { Discover, Person, SeriesSummary, Spot, Title, TitleRating, TrackInfo } from "@tv/api/types";
import { discoverStatus } from "../requests";
import { languageName } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { Poster, Row } from "./cards";
import { openPerson, openPreview, openSeries, openSpot, openTitle } from "./links";

/** TMDB's logo is 273.42 x 35.52 (images/tmdb.svg). */
const TMDB_H = 11;
const TMDB_W = Math.round((TMDB_H * 273.42) / 35.52);
/**
 * The other sources as badges in their own colors, with their names (not their logos: those
 * are trademarks), as the TV draws them (MetaLine).
 */
const BADGES: Record<string, { fill: string; text: string }> = {
  imdb: { fill: "#f5c518", text: "#000000" },
  rotten_tomatoes: { fill: "#fa320a", text: "#ffffff" },
  metacritic: { fill: "#66cc33", text: "#000000" },
};

/** [TMDB] 7.8/10  [IMDb] 8.3/10  [RT] 91%: each source's badge, then its score. */
export function Ratings(props: { ratings: TitleRating[] }) {
  return (
    <Show when={props.ratings.length}>
      <flexboxlayout class="ratings-row" flexWrap="wrap" alignItems="center">
        <For each={props.ratings.slice(0, 4)}>
          {r => (
            <stacklayout orientation="horizontal" class="rating">
              <Show
                when={r.source !== "tmdb"}
                fallback={<image loadMode="async" src="~/images/tmdb.png" width={TMDB_W} height={TMDB_H} verticalAlignment="middle" />}
              >
                <label
                  class="rating-badge"
                  text={r.short}
                  backgroundColor={BADGES[r.source]?.fill ?? "#3a3a3e"}
                  color={BADGES[r.source]?.text ?? "#f4f1ea"}
                />
              </Show>
              <label class="rating-value" text={r.value} />
            </stacklayout>
          )}
        </For>
      </flexboxlayout>
    </Show>
  );
}

/** A round button with its name under it (My List, Watched, Versions...). `icon`: SF Symbol. */
export function Action(props: { icon: string; label: string; onTap: () => void; on?: boolean }) {
  return (
    <stacklayout class="action" on:tap={props.onTap}>
      <gridlayout class={props.on ? "action-circle on" : "action-circle"}>
        <image loadMode="async" class="action-icon" src={`sys://${props.icon}`} tintColor={props.on ? "#141210" : "#f4f1ea"} />
      </gridlayout>
      <label class="action-label" text={props.label} textWrap={true} />
    </stacklayout>
  );
}

/** One of a "More Like This" or film-series row: yours (opens it) or one you could request. */
export interface MoreItem {
  title?: Title;
  show?: SeriesSummary;
  /** One of yours as the server features it (themed rows). */
  spot?: Spot;
  suggestion?: Discover;
}

export function MoreRow(props: { title: string; items: MoreItem[] }) {
  return (
    <Show when={props.items.length}>
      <Row title={props.title}>
        <For each={props.items}>
          {i =>
            i.title ? (
              <Poster
                image={i.title.poster}
                title={i.title.title}
                fraction={i.title.progress && !i.title.progress.finished ? i.title.progress.fraction : 0}
                watched={i.title.progress?.finished}
                onTap={() => openTitle(i.title!.id)}
              />
            ) : i.spot ? (
              <Poster image={i.spot.poster} title={i.spot.title} onTap={() => openSpot(i.spot!)} />
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
                badge={discoverStatus(i.suggestion!).label}
                fraction={discoverStatus(i.suggestion!).progress}
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
export function PeopleRow(props: { people: Person[]; title?: string }) {
  return (
    <Show when={props.people.length}>
      <Row title={props.title ?? t("Cast & Crew")}>
        <For each={props.people}>
          {p => (
            <stacklayout class="person-cell" on:tap={() => p.id && openPerson(p.id, { name: p.name, image: p.image })}>
              <gridlayout class="headshot">
                <label class="headshot-initial" text={p.name.slice(0, 1)} />
                <image loadMode="async" class="headshot" src={imageUrl(p.image)} stretch="aspectFill" />
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
