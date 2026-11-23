// Every movie or show (optionally one genre's), as a grid of posters, A to Z. Shown a page at
// a time ("Show more"), so a big library doesn't load every poster at once.
import { Screen } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { load } from "../data";
import { openSeries, openTitle } from "./links";

const PAGE = 60;

interface Entry {
  key: string;
  title: string;
  poster: string | null;
  open: () => void;
}

const hasGenre = (genres: string | null, genre?: string) =>
  !genre || (genres ?? "").split(/,\s*/).some(g => g === genre);

export function allScreen(kind: "movies" | "shows", genre?: string) {
  const list = load<Entry[]>(async () => {
    const entries: Entry[] =
      kind === "movies"
        ? (await api.titles())
            .filter(m => hasGenre(m.genres, genre))
            .map(m => ({ key: m.id, title: m.title, poster: m.poster, open: () => openTitle(m.id) }))
        : (await api.series())
            .filter(s => hasGenre(s.genres, genre))
            .map(s => ({
              key: s.series,
              title: s.meta_title ?? s.series,
              poster: s.poster,
              open: () => openSeries(s.series),
            }));
    return entries.sort((a, b) => a.title.localeCompare(b.title));
  });
  const [shown, setShown] = createSignal(PAGE);
  // Three posters across, 16 at the sides and 10 between.
  const width = Math.floor((Screen.mainScreen.widthDIPs - 32 - 20) / 3);
  const height = Math.round(width * 1.5);

  return (
    <scrollview>
      <stacklayout class="grid-page">
        <Show when={list.error()}>
          <label class="error" textWrap={true} text={list.error() ?? ""} />
        </Show>
        <Show when={!list.value() && !list.error()}>
          <activityindicator busy={true} class="mt40" />
        </Show>
        <Show when={genre}>
          <label class="muted grid-note" text={t(genre ?? "")} />
        </Show>
        <wraplayout>
          <For each={(list.value() ?? []).slice(0, shown())}>
            {(e, i) => (
              <gridlayout
                class="grid-cell"
                width={width}
                height={height}
                marginRight={i() % 3 === 2 ? 0 : 10}
                on:tap={e.open}
              >
                <Show when={!e.poster}>
                  <label class="small center poster-name" textWrap={true} text={e.title} />
                </Show>
                <image class="grid-poster" src={imageUrl(e.poster)} stretch="aspectFill" />
              </gridlayout>
            )}
          </For>
        </wraplayout>
        <Show when={(list.value()?.length ?? 0) > shown()}>
          <button class="secondary" text={t("Show more")} on:tap={() => setShown(n => n + PAGE)} />
        </Show>
      </stacklayout>
    </scrollview>
  );
}
