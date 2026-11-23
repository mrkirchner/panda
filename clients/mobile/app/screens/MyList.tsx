// My List: your requests first (how each is going, Cancel while nothing has come of it yet),
// then the titles and shows you saved. The TV shows the same at the front of Home's My List.
import { Dialogs } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { MyListEntry, MyRequest } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load, refreshAll } from "../data";
import { bestProgress } from "../requests";
import { Poster, Progress, Row } from "./cards";
import { openPreview, openSeries, openTitle, peekMovie, peekShow } from "./links";

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

  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={shown().length}>
          <label class="section-title" text={t("Requests")} />
          <For each={shown()}>
            {r => (
              <gridlayout class="episode" columns="auto, *, auto" on:tap={() => openRequest(r)}>
                <image col={0} class="request-poster" src={imageUrl(r.poster)} stretch="aspectFill" />
                <stacklayout col={1} class="episode-text">
                  <label class="body" textWrap={true} text={r.year ? `${r.title} (${r.year})` : r.title} />
                  <label class={r.status === "failed" ? "error" : "status-line"} textWrap={true} text={statusOf(r)} />
                  <Show when={bestProgress(r)?.state === "downloading"}>
                    <Progress fraction={bestProgress(r)!.fraction} width={160} />
                  </Show>
                </stacklayout>
                <Show when={cancellable(r)}>
                  <label col={2} class="link cancel-link" text={t("Cancel")} on:tap={() => void cancel(r)} />
                </Show>
              </gridlayout>
            )}
          </For>
        </Show>
        <Show when={list.value()?.length}>
          <Row title={t("My List")}>
            <For each={list.value()!}>
              {m => (
                <Poster
                  image={m.poster}
                  title={m.title}
                  onTap={() => (m.kind === "title" ? peekMovie(m.id) : peekShow(m.id))}
                />
              )}
            </For>
          </Row>
        </Show>
        <Show when={list.value() && requests.value() && !shown().length && !list.value()!.length}>
          <label
            class="muted form"
            textWrap={true}
            text={t("Titles you add with My List, and the ones you request, show up here.")}
          />
        </Show>
      </stacklayout>
    </scrollview>
  );
}
