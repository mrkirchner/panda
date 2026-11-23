// A show: backdrop, facts, overview, Play (the next episode), and its episodes by season.
import { api, imageUrl } from "@tv/api/client";
import type { Item } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createMemo, createSignal } from "solid-js";
import { facts, load, runtime } from "../data";
import { play } from "../player";

/** In progress, else the first one not watched, else the first. */
function nextUp(eps: Item[]): Item | undefined {
  return (
    eps.find(e => e.progress && !e.progress.finished && e.progress.position_secs > 30) ??
    eps.find(e => !e.progress?.finished) ??
    eps[0]
  );
}

const playEpisode = (e: Item) => {
  const p = e.progress;
  const at = p && !p.finished ? p.position_secs : 0;
  play({ kind: "item", id: e.id }, at).catch(err => console.log(`play failed: ${String(err)}`));
};

export function seriesScreen(name: string) {
  const show = load(async () => (await api.series()).find(s => s.series === name) ?? null);
  const episodes = load(async () => {
    const items = await api.items({ series: name, kind: "episode", limit: 10000 });
    return items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  });
  const seasons = createMemo(() => [...new Set((episodes.value() ?? []).map(e => e.season ?? 0))]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const season = () => picked() ?? nextUp(episodes.value() ?? [])?.season ?? seasons()[0] ?? 0;
  const shown = () => (episodes.value() ?? []).filter(e => (e.season ?? 0) === season());
  const next = () => nextUp(episodes.value() ?? []);
  const label = (e: Item) => `S${e.season ?? 0}:E${e.episode ?? 0}`;

  return (
    <scrollview>
      <stacklayout>
        <Show when={show.error() || episodes.error()}>
          <label class="error form" textWrap={true} text={show.error() ?? episodes.error() ?? ""} />
        </Show>
        <image class="hero" src={imageUrl(show.value()?.backdrop)} stretch="aspectFill" />
        <stacklayout class="form">
          <label class="h1" textWrap={true} text={show.value()?.meta_title ?? name} />
          <label
            class="facts"
            textWrap={true}
            text={facts([
              show.value()?.year,
              show.value() ? t("{n} seasons", { n: show.value()!.seasons }) : null,
              show.value()?.rating ? `★ ${show.value()!.rating!.toFixed(1)}` : null,
            ])}
          />
          <Show when={next()}>
            <button
              class="primary"
              text={
                next()!.progress && !next()!.progress!.finished
                  ? t("Resume {episode}", { episode: label(next()!) })
                  : t("Play {episode}", { episode: label(next()!) })
              }
              on:tap={() => playEpisode(next()!)}
            />
          </Show>
          <label class="overview" textWrap={true} text={show.value()?.overview ?? ""} />
        </stacklayout>
        <scrollview orientation="horizontal" scrollBarIndicatorVisible={false}>
          <stacklayout orientation="horizontal" class="row-items">
            <For each={seasons()}>
              {s => (
                <label
                  class={season() === s ? "season-tab selected" : "season-tab"}
                  text={s === 0 ? t("Specials") : t("Season {n}", { n: s })}
                  on:tap={() => setPicked(s)}
                />
              )}
            </For>
          </stacklayout>
        </scrollview>
        <For each={shown()}>
          {e => (
            <gridlayout class="episode" columns="auto, *" on:tap={() => playEpisode(e)}>
              <stacklayout col={0}>
                <image class="still" src={imageUrl(e.episode_still ?? e.backdrop)} stretch="aspectFill" />
                <Show when={e.progress && !e.progress.finished && e.progress.fraction > 0}>
                  <gridlayout class="progress-track still-progress" columns={`${e.progress!.fraction}*, ${1 - e.progress!.fraction}*`}>
                    <stacklayout class="progress-fill" col={0} />
                  </gridlayout>
                </Show>
              </stacklayout>
              <stacklayout col={1} class="episode-text">
                <label class="body" textWrap={true} text={`${e.episode ?? ""}. ${e.episode_title ?? e.title}`} />
                <label
                  class="small"
                  text={facts([runtime(e.duration_secs), e.progress?.finished ? t("Watched") : null])}
                />
                <label class="small" textWrap={true} maxLines={2} text={e.episode_overview ?? ""} />
              </stacklayout>
            </gridlayout>
          )}
        </For>
      </stacklayout>
    </scrollview>
  );
}
