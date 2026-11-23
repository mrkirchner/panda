// My List, one recycling list (only the rows on screen exist): your requests first (how each
// is going, Cancel while nothing has come of it yet), then the titles and shows you saved, three
// to a row. The TV shows the same at the front of Home's My List.
import { Dialogs, Screen, type ContentView } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { MyListEntry, MyRequest } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js";
import { load, refreshAll } from "../data";
import { bestProgress } from "../requests";
import { Progress } from "./cards";
import { createVirtualList } from "../virtual";
import { openPreview, openSeries, openTitle } from "./links";

/** "Downloading 42%", "Searching", "Ready", "Couldn't be added". */
function statusOf(r: MyRequest): string {
  if (r.status === "failed") return r.error ? `${t("Failed")}: ${r.error}` : t("Failed");
  if (r.title_id || r.series) return t("Ready");
  const p = bestProgress(r);
  if (p?.state === "downloading") return t("Downloading {p}%", { p: Math.round(p.fraction * 100) });
  if (p?.state === "importing") return t("Importing");
  if (p?.state === "searching") return t("Searching");
  return t("Requested");
}

export function MyList() {
  const requests = load(() => api.myRequests().catch(() => [] as MyRequest[]), { live: true });
  const list = load(() => api.myList().catch(() => [] as MyListEntry[]), { live: true });
  // Arrived and saved: it shows as a saved title, not a request.
  const shown = () => (requests.value() ?? []).filter(r => !r.listed);

  const openRequest = (r: MyRequest) => {
    if (r.title_id) openTitle(r.title_id);
    else if (r.series) openSeries(r.series);
    else if (r.tmdb_id) openPreview(r.kind, r.tmdb_id);
  };
  const cancel = async (r: MyRequest) => {
    const ok = await Dialogs.confirm({
      title: r.title,
      message: t("Cancel this request?"),
      okButtonText: t("Cancel request"),
      cancelButtonText: t("Keep"),
    });
    if (!ok) return;
    await api.cancelRequest(r.id).catch((e: unknown) => void Dialogs.alert(String(e)));
    refreshAll();
  };
  /** Cancellable while it's still being searched for (nothing downloading yet). */
  const cancellable = (r: MyRequest) => {
    if (r.title_id || r.series || r.status === "failed") return false;
    const p = bestProgress(r);
    return !p || p.state === "searching";
  };

  /** The page as one recycling list (only the rows on screen exist, however long My List gets):
   * the requests, then the saved titles three to a row. */
  type ListRow =
    | { kind: "head"; text: string }
    | { kind: "request"; r: MyRequest }
    | { kind: "posters"; items: MyListEntry[] }
    | { kind: "empty" };
  const rows = createMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    const reqs = shown();
    const saved = list.value() ?? [];
    if (reqs.length) {
      out.push({ kind: "head", text: t("Requests") });
      for (const r of reqs) out.push({ kind: "request", r });
    }
    if (saved.length) {
      out.push({ kind: "head", text: t("My List") });
      for (let i = 0; i < saved.length; i += 3) out.push({ kind: "posters", items: saved.slice(i, i + 3) });
    }
    if (list.value() && requests.value() && !out.length) out.push({ kind: "empty" });
    return out;
  });
  const width = Math.floor((Screen.mainScreen.widthDIPs - 32 - 20) / 3);
  const height = Math.round(width * 1.5);
  const grid = createVirtualList<ListRow>("auto", row => (
    <stacklayout>
      <Switch>
        <Match when={row().kind === "head"}>
          <label class="section-title" text={(row() as { text: string }).text} />
        </Match>
        <Match when={row().kind === "request"}>
          {(() => {
            const r = () => (row() as { r: MyRequest }).r;
            return (
              <gridlayout class="episode" columns="auto, *, auto" on:tap={() => openRequest(r())}>
                <image loadMode="async" col={0} class="request-poster" src={imageUrl(r().poster)} stretch="aspectFill" />
                <stacklayout col={1} class="episode-text">
                  <label class="body" textWrap={true} text={r().year ? `${r().title} (${r().year})` : r().title} />
                  <label class={r().status === "failed" ? "error" : "status-line"} textWrap={true} text={statusOf(r())} />
                  <Show when={bestProgress(r())?.state === "downloading"}>
                    <Progress fraction={bestProgress(r())!.fraction} width={160} />
                  </Show>
                </stacklayout>
                <Show when={cancellable(r())}>
                  <label col={2} class="link cancel-link" text={t("Cancel")} on:tap={() => void cancel(r())} />
                </Show>
              </gridlayout>
            );
          })()}
        </Match>
        <Match when={row().kind === "posters"}>
          <stacklayout orientation="horizontal" class="grid-row">
            <For each={(row() as { items: MyListEntry[] }).items} keyed={false}>
              {(m, i) => (
                <gridlayout
                  class="grid-cell"
                  width={width}
                  height={height}
                  marginRight={i === 2 ? 0 : 10}
                  on:tap={() => (m().kind === "title" ? openTitle(m().id) : openSeries(m().id))}
                >
                  <Show when={!m().poster}>
                    <label class="small center poster-name" textWrap={true} text={m().title} />
                  </Show>
                  <image loadMode="async" class="grid-poster" src={imageUrl(m().poster)} stretch="aspectFill" />
                </gridlayout>
              )}
            </For>
          </stacklayout>
        </Match>
        <Match when={row().kind === "empty"}>
          <label
            class="muted form"
            textWrap={true}
            text={t("Titles you add with My List, and the ones you request, show up here.")}
          />
        </Match>
      </Switch>
    </stacklayout>
  ));
  createEffect(rows, r => grid.update(r));

  return <contentview ref={(el: ContentView) => (el.content = grid.view)} />;
}
