// Home: what to keep watching, your list, and what's new, as on the TV (`/api/home`), laid out
// for a phone: a featured title on top, then rows that scroll sideways.
import { api, ensureSession, imageUrl } from "@tv/api/client";
import type { ContinueEntry, Featured, Home as HomeData, Title } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";
import { open } from "../nav";
import { play } from "../player";
import { Poster, Row, WideCard } from "./cards";
import { seriesScreen } from "./Series";
import { titleScreen } from "./Title";

export const openTitle = (id: string) => open(() => titleScreen(id), { title: "" });
export const openSeries = (name: string) => open(() => seriesScreen(name), { title: "" });

const asFeatured = (f: Featured | Title): Featured =>
  "kind" in f ? { reason: "Recently added", movie: f } : f;

function resume(e: ContinueEntry) {
  const at = e.up_next ? 0 : e.position_secs;
  const target = e.kind === "movie" && e.title_id ? { kind: "title" as const, id: e.title_id } : { kind: "item" as const, id: e.item_id };
  play(target, at).catch(err => console.log(`play failed: ${String(err)}`));
}

function Hero(props: { f: Featured }) {
  const name = () => props.f.movie?.title ?? props.f.series?.meta_title ?? props.f.series?.series ?? "";
  const backdrop = () => props.f.movie?.backdrop ?? props.f.series?.backdrop ?? null;
  const tap = () => (props.f.movie ? openTitle(props.f.movie.id) : props.f.series && openSeries(props.f.series.series));
  return (
    <stacklayout on:tap={tap}>
      <image class="hero" src={imageUrl(backdrop())} stretch="aspectFill" />
      <stacklayout class="hero-text">
        <label class="small accent" text={t(props.f.reason)} />
        <label class="h1" textWrap={true} text={name()} />
      </stacklayout>
    </stacklayout>
  );
}

export function Home() {
  const data = load<HomeData>(async () => {
    await ensureSession();
    return api.home();
  });
  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <Show when={!data.value() && !data.error()}>
          <activityindicator busy={true} class="mt40" />
        </Show>
        <Show when={data.value()?.featured.length}>
          <Hero f={asFeatured(data.value()!.featured[0])} />
        </Show>
        <Show when={data.value()?.continue_watching.length}>
          <Row title={t("Continue Watching")}>
            <For each={data.value()!.continue_watching}>
              {e => (
                <WideCard
                  image={e.backdrop}
                  title={e.title}
                  subtitle={e.subtitle}
                  fraction={e.up_next ? 0 : e.fraction}
                  onTap={() => resume(e)}
                />
              )}
            </For>
          </Row>
        </Show>
        <Show when={data.value()?.my_list.length}>
          <Row title={t("My List")}>
            <For each={data.value()!.my_list}>
              {m => (
                <Poster
                  image={m.poster}
                  title={m.title}
                  onTap={() => (m.kind === "title" ? openTitle(m.id) : openSeries(m.id))}
                />
              )}
            </For>
          </Row>
        </Show>
        <Show when={data.value()?.recently_added_movies.length}>
          <Row title={t("Recently added movies")}>
            <For each={data.value()!.recently_added_movies}>
              {m => <Poster image={m.poster} title={m.title} onTap={() => openTitle(m.id)} />}
            </For>
          </Row>
        </Show>
        <Show when={data.value()?.recently_added_shows.length}>
          <Row title={t("Recently added shows")}>
            <For each={data.value()!.recently_added_shows}>
              {s => <Poster image={s.poster} title={s.meta_title ?? s.series} onTap={() => openSeries(s.series)} />}
            </For>
          </Row>
        </Show>
      </stacklayout>
    </scrollview>
  );
}
