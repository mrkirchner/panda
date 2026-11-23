// The parts of a movie's, show's, person's or preview page below the header: ratings, actions,
// rows of titles (yours and ones you could request), the cast, and facts (as the TV's).
import { imageUrl } from "@tv/api/client";
import type { Discover, Person, SeriesSummary, Spot, Title, TitleRating, TrackInfo } from "@tv/api/types";
import { languageName } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { href, paths } from "../nav";
import { discoverStatus } from "../requests";
import { Poster, Row } from "./cards";
import { Icon, type IconName } from "./icons";

/** The other sources as badges in their own colors, with their names (not their logos: those
 * are trademarks), as the TV draws them. TMDB's own logo is its attribution. */
const BADGES: Record<string, { fill: string; text: string }> = {
  imdb: { fill: "#f5c518", text: "#000000" },
  rotten_tomatoes: { fill: "#fa320a", text: "#ffffff" },
  metacritic: { fill: "#66cc33", text: "#000000" },
};

export function Ratings(props: { ratings: TitleRating[] }) {
  return (
    <Show when={props.ratings.length}>
      <div class="ratings">
        <For each={props.ratings.slice(0, 4)}>
          {(r) => (
            <span class="rating">
              <Show
                when={r.source !== "tmdb"}
                fallback={<img src={`${import.meta.env.BASE_URL}images/tmdb.svg`} alt="TMDB" />}
              >
                <span
                  class="rating-badge"
                  style={{
                    background: BADGES[r.source]?.fill ?? "#3a3a3e",
                    color: BADGES[r.source]?.text ?? "#f4f1ea",
                  }}
                >
                  {r.short}
                </span>
              </Show>
              <span>{r.value}</span>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

/** A rounded action next to Play (My List, Watched, Versions...). */
export function Action(props: {
  icon: IconName;
  label: string;
  onClick: (e: MouseEvent) => void;
  on?: boolean;
}) {
  return (
    <button class={["round-action", { on: !!props.on }]} onClick={(e) => props.onClick(e)}>
      <Icon name={props.icon} size={20} />
      <span>{props.label}</span>
    </button>
  );
}

/** One of a "More Like This" or film-series row: yours (opens it) or one you could request. */
export interface MoreItem {
  title?: Title;
  show?: SeriesSummary;
  spot?: Spot;
  suggestion?: Discover;
}

const keyOf = (i: MoreItem) =>
  i.title
    ? `t:${i.title.id}`
    : i.spot
      ? `s:${i.spot.kind}:${i.spot.id}`
      : i.show
        ? `w:${i.show.series}`
        : `d:${i.suggestion?.kind}:${i.suggestion?.tmdb_id}`;

/** A row of posters: yours (with progress) and ones you could request (with their status).
 * Matched by title across reloads, so a refresh updates posters instead of rebuilding them. */
export function MoreRow(props: { title: string; items: MoreItem[]; link?: { label: string; href: string } }) {
  return (
    <Show when={props.items.length}>
      <Row title={props.title} link={props.link}>
        <For each={props.items} keyed={keyOf}>
          {(item) => (
            <Show
              when={item().suggestion}
              fallback={
                <Poster
                  image={item().title?.poster ?? item().spot?.poster ?? item().show?.poster ?? null}
                  title={
                    item().title?.title ??
                    item().spot?.title ??
                    item().show?.meta_title ??
                    item().show?.series ??
                    ""
                  }
                  fraction={
                    item().title?.progress && !item().title!.progress!.finished
                      ? item().title!.progress!.fraction
                      : 0
                  }
                  watched={item().title?.progress?.finished}
                  href={href(
                    item().title
                      ? paths.title(item().title!.id)
                      : item().spot
                        ? paths.spot(item().spot!)
                        : paths.series(item().show?.series ?? ""),
                  )}
                />
              }
            >
              {(s) => (
                <Poster
                  image={s().poster}
                  title={s().title}
                  badge={discoverStatus(s()).label}
                  badgeTone={discoverStatus(s()).tone}
                  fraction={discoverStatus(s()).progress}
                  href={href(paths.preview(s().kind, s().tmdb_id))}
                />
              )}
            </Show>
          )}
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
          {(p) => (
            <a
              class="person-cell"
              href={
                p.id
                  ? href(
                      `${paths.person(p.id)}?name=${encodeURIComponent(p.name)}&image=${encodeURIComponent(p.image ?? "")}`,
                    )
                  : undefined
              }
            >
              <span class="headshot">
                {p.name.slice(0, 1)}
                <Show when={imageUrl(p.image)}>
                  {(src) => <img src={src()} alt="" loading="lazy" decoding="async" />}
                </Show>
              </span>
              <div class="person-name">{p.name}</div>
              <div class="person-role">{p.role ?? ""}</div>
            </a>
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

/** A heading and its facts (label over value); facts without a value are left out. */
export function Facts(props: { title: string; facts: Fact[] }) {
  const shown = () => props.facts.filter((f) => f.value);
  return (
    <Show when={shown().length}>
      <div class="facts-block">
        <h3>{props.title}</h3>
        <For each={shown()}>
          {(f) => (
            <div class="fact">
              <div class="label">{f.label}</div>
              <div>{f.value}</div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** "English (5.1), Spanish" from a file's tracks (unknown languages left out). */
export function trackList(tracks: TrackInfo[] | undefined): string | null {
  const names = (tracks ?? [])
    .map((tr) => {
      const name = languageName(tr.language);
      return name ? (tr.detail ? `${name} (${tr.detail})` : name) : null;
    })
    .filter((n): n is string => !!n);
  return names.length ? [...new Set(names)].join(", ") : null;
}

/** "Starring: A, B, C" and "Director: D" (or "Created by"), for a detail page's side. */
export function Credits(props: { cast: Person[]; directors: Person[]; createdBy?: boolean }) {
  return (
    <div class="detail-side">
      <Show when={props.cast.length}>
        <div>
          <b>{t("Starring")}: </b>
          <For each={props.cast.slice(0, 4)}>
            {(p, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <Show when={p.id} fallback={p.name}>
                  <a href={href(paths.person(p.id!))}>{p.name}</a>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.directors.length}>
        <div>
          <b>{props.createdBy ? t("Created by") : t("Director")}: </b>
          {props.directors.map((p) => p.name).join(", ")}
        </div>
      </Show>
    </div>
  );
}
