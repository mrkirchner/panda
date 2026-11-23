// Movies, Shows, one library, and a genre's page, laid out like the TV's (`/api/browse/{kind}`,
// `/api/browse/library/{id}`, `/api/genres/{name}`): the hero, a ranked Top 10, Recently added,
// then a row per genre. Movies and Shows list their libraries when there are several of the
// kind (the TV's per-library tabs).
import { api } from "@tv/api/client";
import type { GenrePage, Library } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";
import { open } from "../nav";
import { OfflineBanner } from "../offline";
import { Poster, Row } from "./cards";
import { Hero } from "./Hero";
import { spotSlide } from "./heroSlides";
import { openAll, peekSpot } from "./links";

/** What the page is: a kind (Movies/Shows tab), one library, or a genre. */
export type BrowseKind =
  | { of: "kind"; kind: "movies" | "shows" }
  | { of: "library"; library: Library }
  | { of: "genre"; name: string };

export function browseScreen(fetchPage: () => Promise<GenrePage>, what: BrowseKind) {
  const page = load(fetchPage);
  const libraries = load(() =>
    what.of === "kind" ? api.libraries().catch(() => [] as Library[]) : Promise.resolve([] as Library[]),
  );
  const ofKind = () => (what.of === "kind" ? (libraries.value() ?? []).filter(l => l.kind === what.kind) : []);
  const seeAll = () => {
    const p = page.value();
    if (!p) return;
    if (what.of === "library") openAll(what.library.kind, undefined, what.library.id);
    else if (what.of === "genre") openAll(p.kind, p.name);
    else openAll(what.kind);
  };
  /** "Top 10 Movies", "Top 10 Shows", "Top 10 Drama" (the TV's). */
  const topTitle = () =>
    what.of === "genre"
      ? t("Top 10 {genre}", { genre: t(what.name) })
      : (what.of === "kind" ? what.kind : what.library.kind) === "movies"
        ? t("Top 10 Movies")
        : t("Top 10 Shows");
  const empty = () => {
    const p = page.value();
    return !!p && !p.featured.length && !p.top.length && !p.recent.length && !p.paired.length;
  };
  return (
    <scrollview>
      <stacklayout class="home">
        <OfflineBanner />
        <Show when={page.error()}>
          <label class="error form" textWrap={true} text={page.error() ?? ""} />
        </Show>
        <Show when={!page.value() && !page.error()}>
          <activityindicator busy={true} class="mt40" />
        </Show>
        <Show when={empty()}>
          <label
            class="muted form"
            textWrap={true}
            text={what.of === "genre" ? t("Nothing in this genre yet.") : t("Nothing here yet.")}
          />
        </Show>
        <Show when={page.value()?.featured.length}>
          <Hero slides={page.value()!.featured.map(spotSlide)} />
        </Show>
        <Show when={ofKind().length > 1}>
          <scrollview orientation="horizontal" scrollBarIndicatorVisible={false}>
            <stacklayout orientation="horizontal" class="row-items library-chips">
              <For each={ofKind()}>
                {l => (
                  <label
                    class="chip"
                    text={l.name}
                    on:tap={() =>
                      open(() => browseScreen(() => api.libraryPage(String(l.id)), { of: "library", library: l }), {
                        title: l.name,
                      })
                    }
                  />
                )}
              </For>
            </stacklayout>
          </scrollview>
        </Show>
        <Show when={page.value() && what.of !== "kind" && !empty()}>
          <button class="secondary browse-all" text={t("See all {n}", { n: page.value()!.count })} on:tap={seeAll} />
        </Show>
        <Show when={page.value()?.top.length}>
          <Row title={topTitle()}>
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
