// Movies, Shows and a genre's page, laid out like the TV's (`/api/browse/{kind}`,
// `/api/genres/{name}`): Featured, a ranked Top 10, Recently added, then a row per genre.
import type { GenrePage } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";
import { Poster, Row } from "./cards";
import { Hero } from "./Hero";
import { spotSlide } from "./heroSlides";
import { openAll, peekSpot } from "./links";

/** `fetchPage`: the page's data. `all`: which list "All" opens (null: the page's own kind, filtered to it). */
export function browseScreen(fetchPage: () => Promise<GenrePage>, all: "movies" | "shows" | null) {
  const page = load(fetchPage);
  const seeAll = () => {
    const p = page.value();
    if (p) openAll(all ?? p.kind, all ? undefined : p.name);
  };
  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={page.error()}>
          <label class="error form" textWrap={true} text={page.error() ?? ""} />
        </Show>
        <Show when={!page.value() && !page.error()}>
          <activityindicator busy={true} class="mt40" />
        </Show>
        <Show when={page.value()?.featured.length}>
          <Hero slides={page.value()!.featured.map(spotSlide)} />
        </Show>
        <Show when={page.value() && !all}>
          <button class="secondary browse-all" text={t("See all {n}", { n: page.value()!.count })} on:tap={seeAll} />
        </Show>
        <Show when={page.value()?.top.length}>
          <Row title={t("Top 10")}>
            <For each={page.value()!.top.slice(0, 10)}>
              {(s, i) => <Poster image={s.poster} title={s.title} rank={i() + 1} onTap={() => peekSpot(s)} />}
            </For>
          </Row>
        </Show>
        <Show when={page.value()?.recent.length}>
          <Row title={t("Recently added")}>
            <For each={page.value()!.recent}>
              {s => <Poster image={s.poster} title={s.title} onTap={() => peekSpot(s)} />}
            </For>
          </Row>
        </Show>
        <For each={page.value()?.paired ?? []}>
          {g => (
            <Row title={t(g.genre)}>
              <For each={g.items}>{s => <Poster image={s.poster} title={s.title} onTap={() => peekSpot(s)} />}</For>
            </Row>
          )}
        </For>
      </stacklayout>
    </scrollview>
  );
}
