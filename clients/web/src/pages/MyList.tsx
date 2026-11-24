// My List: your requests first (how each is going, Cancel while nothing has come of it yet), then
// the titles and shows you saved, as a grid. The TV shows the same at the front of Home's My List.
import { api, imageUrl } from "@tv/api/client";
import type { MyListEntry, MyRequest } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal, onSettled } from "solid-js";
import { Poster, Progress } from "../components/cards";
import { VirtualGrid } from "../components/VirtualGrid";
import { confirmAction, toast } from "../components/ui";
import { load, message, refreshAll } from "../data";
import { href, paths } from "../nav";
import { bestProgress, myRequests, refreshRequests } from "../requests";

/** "Downloading 42%", "Searching", "Ready", "Failed: ...". */
function statusOf(r: MyRequest): string {
  if (r.status === "failed") return r.error ? `${t("Failed")}: ${r.error}` : t("Failed");
  if (r.title_id || r.series) return t("Ready");
  const p = bestProgress(r);
  if (p?.state === "downloading") return t("Downloading {p}%", { p: Math.round(p.fraction * 100) });
  if (p?.state === "importing") return t("Importing");
  if (p?.state === "searching") return t("Searching");
  return t("Requested");
}

const requestPath = (r: MyRequest) =>
  r.title_id
    ? paths.title(r.title_id)
    : r.series
      ? paths.series(r.series)
      : r.tmdb_id
        ? paths.preview(r.kind, r.tmdb_id)
        : null;

/** Cancellable while it's still being searched for (nothing downloading yet). */
const cancellable = (r: MyRequest) => {
  if (r.title_id || r.series || r.status === "failed") return false;
  const p = bestProgress(r);
  return !p || p.state === "searching";
};

export default function MyList() {
  // The shared store (polled every 20 s while anything is on its way, as the TV does).
  const [requestsLoaded, setRequestsLoaded] = createSignal(false);
  onSettled(() => {
    void refreshRequests().finally(() => setRequestsLoaded(true));
  });
  const list = load(() => api.myList().catch(() => [] as MyListEntry[]), { live: true });
  const shown = () => myRequests().filter((r) => !r.listed);

  const cancel = async (r: MyRequest) => {
    if (!(await confirmAction(r.title, t("Cancel this request?"), t("Cancel request"), true))) return;
    await api.cancelRequest(r.id).catch((e: unknown) => toast(message(e)));
    refreshAll();
  };

  return (
    <div class="page-top">
      <div class="page-head">
        <h1>{t("My List")}</h1>
      </div>
      <Show when={shown().length}>
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">{t("Requests")}</h2>
          </div>
          <div class="request-list">
            <For each={shown()}>
              {(r) => (
                <div class="request-row">
                  <a class="request-poster" href={requestPath(r) ? href(requestPath(r)!) : undefined}>
                    <Show when={imageUrl(r.poster)}>
                      {(src) => <img src={src()} alt="" loading="lazy" />}
                    </Show>
                  </a>
                  <div class="request-text">
                    <a href={requestPath(r) ? href(requestPath(r)!) : undefined}>
                      <b>{r.year ? `${r.title} (${r.year})` : r.title}</b>
                    </a>
                    <span class={r.status === "failed" ? "error" : "status-line"}>{statusOf(r)}</span>
                    <Show when={bestProgress(r)?.state === "downloading"}>
                      <div class="request-progress">
                        <Progress fraction={bestProgress(r)!.fraction} />
                      </div>
                    </Show>
                  </div>
                  <Show when={cancellable(r)}>
                    <button class="btn small" onClick={() => void cancel(r)}>
                      {t("Cancel")}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>
      <Show when={list.value()?.length}>
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">{t("Saved")}</h2>
          </div>
          {/* Virtual, like the All grid: only the rows near the screen exist, however long it gets. */}
          <VirtualGrid
            items={list.value()!}
            cell={(m) => (
              <Poster
                image={m().poster}
                title={m().title}
                href={href(m().kind === "title" ? paths.title(m().id) : paths.series(m().id))}
              />
            )}
          />
        </section>
      </Show>
      <Show when={!list.value() || !requestsLoaded()}>
        <div class="poster-grid section">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => <div class="ghost" style={{ "aspect-ratio": "2 / 3" }} />}
          </For>
        </div>
      </Show>
      <Show when={list.value() && requestsLoaded() && !shown().length && !list.value()!.length}>
        <p class="empty">{t("Titles you add with My List, and the ones you request, show up here.")}</p>
      </Show>
    </div>
  );
}
