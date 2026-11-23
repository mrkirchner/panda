// Movies, Shows, one library, and a genre's page, laid out like the TV's (`/api/browse/{kind}`,
// `/api/browse/library/{id}`, `/api/genres/{name}`): the hero (Featured), a ranked Top 10,
// Recently added, then a row per genre most often paired with it. Movies and Shows list their
// libraries when there are several of the kind; "All movies"/"See all" opens the grid.
import { useParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import type { GenrePage as Page, Library } from "@tv/api/types";
import { t, tn } from "@tv/i18n";
import { For, Show, createMemo } from "solid-js";
import { Art, GhostHero, GhostRow, Poster, Row } from "../components/cards";
import { Hero } from "../components/Hero";
import { spotSlide } from "../components/heroSlides";
import { load } from "../data";
import { libraries } from "../features";
import { href, paths } from "../nav";

type What =
  { of: "kind"; kind: "movies" | "shows" } | { of: "library"; id: number } | { of: "genre"; name: string };

function BrowseView(props: { what: What; fetch: () => Promise<Page> }) {
  const page = load(() => props.fetch());
  const libs = load(() => libraries());
  const p = () => page.value();
  const library = () =>
    props.what.of === "library"
      ? libs.value()?.find((l) => l.id === (props.what as { id: number }).id)
      : undefined;
  const kind = () =>
    props.what.of === "kind"
      ? props.what.kind
      : props.what.of === "library"
        ? (library()?.kind ?? p()?.kind)
        : p()?.kind;
  const ofKind = () =>
    props.what.of === "kind" ? (libs.value() ?? []).filter((l: Library) => l.kind === kind()) : [];
  const allHref = () => {
    const w = props.what;
    const k = kind() ?? "movies";
    if (w.of === "library") return href(paths.all(k, { library: w.id }));
    if (w.of === "genre") return href(paths.all(k, { genre: w.name }));
    return href(paths.all(k));
  };
  const name = () =>
    props.what.of === "genre"
      ? t(props.what.name)
      : props.what.of === "library"
        ? (library()?.name ?? "")
        : props.what.kind === "movies"
          ? t("Movies")
          : t("Shows");
  const topTitle = () =>
    props.what.of === "genre"
      ? t("Top 10 {genre}", { genre: t(props.what.name) })
      : kind() === "shows"
        ? t("Top 10 Shows")
        : t("Top 10 Movies");
  const empty = () =>
    !!p() && !p()!.featured.length && !p()!.top.length && !p()!.recent.length && !p()!.paired.length;
  const slides = createMemo(() => (p()?.featured ?? []).map(spotSlide));
  const seeAll = () =>
    props.what.of === "kind"
      ? props.what.kind === "movies"
        ? t("All movies")
        : t("All shows")
      : t("See all {n}", { n: p()?.count ?? 0 });

  return (
    <>
      <Show when={page.error()}>
        <p class="empty error page-top">{page.error()}</p>
      </Show>
      <Show when={!p() && !page.error()}>
        <GhostHero />
        <GhostRow />
        <GhostRow />
      </Show>
      {/* A genre: its name over a tinted backdrop with "See all" (the TV's). */}
      <Show when={props.what.of === "genre" && p()}>
        <header class="genre-head">
          <Art image={p()!.backdrop} alt="" eager />
          <h1>{name()}</h1>
          <span class="muted">{tn(p()!.count, "{n} title", "{n} titles")}</span>
          <div>
            <a class="btn" href={allHref()}>
              {seeAll()}
            </a>
          </div>
        </header>
      </Show>
      <Show when={props.what.of !== "genre" && slides().length}>
        <Hero slides={slides()} />
      </Show>
      <Show when={props.what.of !== "genre" && p()}>
        <div class={["page-head", slides().length ? "after-hero" : "page-top"]}>
          <h1>{name()}</h1>
          <a class="btn small" href={allHref()}>
            {seeAll()}
          </a>
          <Show when={ofKind().length > 1}>
            <div class="chips">
              <For each={ofKind()}>
                {(l) => (
                  <a class="chip" href={href(paths.library(l.id))}>
                    {l.name}
                  </a>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={empty()}>
        <p class="empty">
          {props.what.of === "genre" ? t("Nothing in this genre yet.") : t("Nothing here yet.")}
        </p>
      </Show>
      {/* A genre's Featured: tall cards (its hero on the other pages). */}
      <Show when={props.what.of === "genre" && p()?.featured.length}>
        <Row title={t("Featured")}>
          <For each={p()!.featured}>
            {(s) => <Poster image={s.poster} title={s.title} href={href(paths.spot(s))} />}
          </For>
        </Row>
      </Show>
      <Show when={p()?.top.length}>
        <Row title={topTitle()}>
          <For each={p()!.top.slice(0, 10)}>
            {(s, i) => <Poster image={s.poster} title={s.title} rank={i() + 1} href={href(paths.spot(s))} />}
          </For>
        </Row>
      </Show>
      <Show when={p()?.recent.length}>
        <Row title={t("Recently added")}>
          <For each={p()!.recent}>
            {(s) => <Poster image={s.poster} title={s.title} href={href(paths.spot(s))} />}
          </For>
        </Row>
      </Show>
      <For each={p()?.paired ?? []}>
        {(g) => (
          <Row title={t(g.genre)} link={{ label: t("See all"), href: href(paths.genre(g.genre)) }}>
            <For each={g.items}>
              {(s) => <Poster image={s.poster} title={s.title} href={href(paths.spot(s))} />}
            </For>
          </Row>
        )}
      </For>
    </>
  );
}

export function MoviesPage() {
  return <BrowseView what={{ of: "kind", kind: "movies" }} fetch={() => api.browsePage("movies")} />;
}

export function ShowsPage() {
  return <BrowseView what={{ of: "kind", kind: "shows" }} fetch={() => api.browsePage("shows")} />;
}

export function LibraryPage() {
  const params = useParams<{ id: string }>();
  return (
    <Show when={params.id} keyed>
      {(id) => <BrowseView what={{ of: "library", id: Number(id) }} fetch={() => api.libraryPage(id)} />}
    </Show>
  );
}

export function GenrePage() {
  const params = useParams<{ name: string }>();
  return (
    <Show when={params.name} keyed>
      {(name) => <BrowseView what={{ of: "genre", name }} fetch={() => api.genrePage(name)} />}
    </Show>
  );
}
