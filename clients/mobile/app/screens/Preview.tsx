// A title you don't have (from More Like This, a person's page or Search), laid out like your
// own (`/api/discover/{kind}/{tmdb_id}`): backdrop, facts, ratings, Request (or how the request is
// going, and Cancel while nothing has come of it), its film series, More Like This, Cast & Crew,
// Information. In your library after all: that page instead.
import { Dialogs, Screen } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Preview } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { Show, createSignal } from "solid-js";
import { facts, load, longDate, runtime } from "../data";
import { bestProgress, requestStatus } from "../requests";
import { Facts, MoreRow, PeopleRow, Ratings } from "./sections";
import { Logo } from "./cards";
import { seriesScreen } from "./Series";
import { titleScreen } from "./Title";

export function previewScreen(kind: "movie" | "series", tmdbId: number) {
  const data = load<Preview>(() => api.preview(kind, tmdbId));
  const status = requestStatus();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const p = () => data.value();

  /** Shows ask which seasons first (when TMDB knows how many). */
  const request = async () => {
    const i = p();
    if (!i?.can_request || busy()) return;
    let seasons: number[] | null = null;
    if (i.kind === "series" && (i.seasons ?? 0) > 1) {
      const all = t("All seasons");
      const options = [all, ...Array.from({ length: i.seasons! }, (_, n) => t("Season {n}", { n: n + 1 }))];
      const pick = await Dialogs.action({ title: t("Request"), cancelButtonText: t("Cancel"), actions: options });
      const n = options.indexOf(pick);
      if (n < 0) return;
      if (n > 0) seasons = [n];
    }
    setBusy(true);
    setError("");
    try {
      await api.request(i, seasons);
      data.reload();
      void status.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /** Your request while nothing has come of it yet (searching): it can be cancelled. */
  const cancellable = () => {
    const i = p();
    const r = i ? status.find(i) : undefined;
    if (!r || i!.downloaded) return undefined;
    const prog = bestProgress(r);
    return !prog || prog.state === "searching" ? r : undefined;
  };
  const cancel = async () => {
    const r = cancellable();
    if (!r) return;
    try {
      await api.cancelRequest(r.id);
      await status.refresh();
      data.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Show
      when={!p()?.library}
      fallback={p()!.kind === "movie" ? titleScreen(p()!.library!) : seriesScreen(p()!.library!)}
    >
      <scrollview>
        <stacklayout class="home">
          <Show when={data.error()}>
            <label class="error form" textWrap={true} text={data.error() ?? ""} />
          </Show>
          <Show when={p()}>
            <image class="hero" src={imageUrl(p()!.backdrop)} stretch="aspectFill" />
            <stacklayout class="form">
              <Show when={p()!.details.logo} fallback={<label class="h1" textWrap={true} text={p()!.title} />}>
                <Logo image={p()!.details.logo} height={70} maxWidth={Screen.mainScreen.widthDIPs * 0.7} />
              </Show>
              <label
                class="facts"
                textWrap={true}
                text={facts([
                  p()!.year,
                  p()!.seasons ? t("{n} seasons", { n: p()!.seasons! }) : runtime((p()!.runtime_mins ?? 0) * 60),
                  p()!.details.certification,
                  (p()!.genres ?? "").split(/,\s*/).slice(0, 3).join(", "),
                ])}
              />
              <Ratings ratings={p()!.details.ratings?.length ? p()!.details.ratings! : tmdbRating(p()!.rating)} />
              <label class="status-line" text={t("Not in your library")} />
              <Show when={status(p()!).label}>
                <button
                  class={status(p()!).action ? "primary" : "secondary"}
                  text={busy() ? t("Requesting...") : (status(p()!).label ?? "")}
                  isEnabled={status(p()!).action && !busy()}
                  on:tap={() => void request()}
                />
              </Show>
              <Show when={cancellable()}>
                <button class="secondary" text={t("Cancel request")} on:tap={() => void cancel()} />
              </Show>
              <Show when={error()}>
                <label class="error mt10" textWrap={true} text={error()} />
              </Show>
              <Show when={p()!.details.tagline}>
                <label class="body accent mt24" textWrap={true} text={p()!.details.tagline ?? ""} />
              </Show>
              <label class="overview" textWrap={true} text={p()!.overview ?? ""} />
            </stacklayout>
            <Show when={(p()!.collection?.items.length ?? 0) > 1}>
              <MoreRow
                title={p()!.collection!.name}
                items={p()!.collection!.items.map(i => ({ title: i.title, suggestion: i.suggestion }))}
              />
            </Show>
            <MoreRow title={t("More Like This")} items={(p()!.more ?? []).map(suggestion => ({ suggestion }))} />
            <PeopleRow people={[...p()!.details.directors, ...p()!.details.cast]} />
            <Facts
              title={t("Information")}
              facts={[
                { label: p()!.kind === "series" ? t("Network") : t("Studio"), value: p()!.details.studios.join(", ") },
                {
                  label: p()!.kind === "series" ? t("First aired") : t("Released"),
                  value: longDate(p()!.details.release_date),
                },
                { label: t("Rated"), value: p()!.details.certification },
                { label: t("Status"), value: p()!.details.status },
                { label: t("Region of origin"), value: p()!.details.countries?.join(", ") },
              ]}
            />
          </Show>
        </stacklayout>
      </scrollview>
    </Show>
  );
}
