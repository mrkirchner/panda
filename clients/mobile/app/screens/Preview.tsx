// A title you don't have (from More Like This, a person's page or Search), laid out like your
// own (`/api/discover/{kind}/{tmdb_id}`): backdrop, facts, ratings, Request (or how the request is
// going, and Cancel while nothing has come of it), its film series, More Like This, Cast & Crew,
// Information. In your library after all: that page instead.
import { Dialogs, Screen } from "@nativescript/core";
import { api, imageUrl } from "@tv/api/client";
import type { Preview } from "@tv/api/types";
import { tmdbRating } from "@tv/format";
import { t, tn } from "@tv/i18n";
import { Show, createSignal } from "solid-js";
import { facts, load, longDate, refreshAll, runtime } from "../data";
import { bestProgress, discoverStatus, refreshRequests, requestFor } from "../requests";
import { Facts, MoreRow, PeopleRow, Ratings, trackList } from "./sections";
import { GhostRow, Logo } from "./cards";
import { pickSeasons } from "./SeasonPicker";
import { seriesScreen } from "./Series";
import { titleScreen } from "./Title";

export function previewScreen(kind: "movie" | "series", tmdbId: number) {
  const data = load<Preview>(() => api.preview(kind, tmdbId));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const p = () => data.value();

  /** Shows ask which seasons first (when TMDB knows how many). */
  const request = async () => {
    const i = p();
    if (!i?.can_request || busy()) return;
    let seasons: number[] | null = null;
    if (i.kind === "series" && (i.seasons ?? 0) > 1) {
      // The TV's picker: All, or any of them.
      const picked = await pickSeasons(
        Array.from({ length: i.seasons! }, (_, n) => n + 1),
        i.title,
        t("Request"),
      );
      if (picked === undefined) return;
      seasons = picked;
    }
    setBusy(true);
    setError("");
    try {
      await api.request(i, seasons);
      data.reload();
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /** Your request while nothing has come of it yet (searching): it can be cancelled. */
  const cancellable = () => {
    const i = p();
    const r = i ? requestFor(i) : undefined;
    if (!r || i!.downloaded) return undefined;
    const prog = bestProgress(r);
    return !prog || prog.state === "searching" ? r : undefined;
  };
  const cancel = async () => {
    const r = cancellable();
    if (!r) return;
    try {
      await api.cancelRequest(r.id);
      await refreshRequests();
      data.reload();
      refreshAll();
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
          {/* TMDB can take a moment: the page's shape as ghosts meanwhile. */}
          <Show when={!p() && !data.error()}>
            <stacklayout class="ghost hero" />
            <stacklayout class="form">
              <stacklayout class="ghost ghost-line" />
              <stacklayout class="ghost ghost-line" />
              <stacklayout class="ghost ghost-text" />
            </stacklayout>
            <GhostRow />
          </Show>
          <Show when={p()}>
            <image loadMode="async" class="hero" src={imageUrl(p()!.backdrop)} stretch="aspectFill" />
            <stacklayout class="form">
              <Show when={p()!.details.logo} fallback={<label class="h1" textWrap={true} text={p()!.title} />}>
                <Logo image={p()!.details.logo} height={70} maxWidth={Screen.mainScreen.widthDIPs * 0.7} />
              </Show>
              <label
                class="facts"
                textWrap={true}
                text={facts([
                  p()!.year,
                  p()!.seasons ? tn(p()!.seasons!, "{n} season", "{n} seasons") : runtime((p()!.runtime_mins ?? 0) * 60),
                  p()!.details.certification,
                  (p()!.genres ?? "").split(/,\s*/).slice(0, 3).join(", "),
                  p()!.details.next_episode
                    ? t("Next: S{s} E{e}, {date}", {
                        s: p()!.details.next_episode!.season,
                        e: p()!.details.next_episode!.episode,
                        date: longDate(p()!.details.next_episode!.air_date) ?? t("soon"),
                      })
                    : null,
                ])}
              />
              <Ratings ratings={p()!.details.ratings?.length ? p()!.details.ratings! : tmdbRating(p()!.rating)} />
              <label class="status-line" text={t("Not in your library")} />
              <Show when={discoverStatus(p()!).label}>
                <button
                  class={discoverStatus(p()!).action ? "primary" : "secondary"}
                  text={busy() ? t("Requesting...") : (discoverStatus(p()!).label ?? "")}
                  isEnabled={discoverStatus(p()!).action && !busy()}
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
              <label
                class="credits-line"
                textWrap={true}
                text={[
                  p()!.details.cast.length
                    ? `${t("Starring")}: ${p()!.details.cast.slice(0, 3).map(c => c.name).join(", ")}`
                    : "",
                  p()!.details.directors.length
                    ? `${p()!.kind === "series" ? t("Created by") : t("Director")}: ${p()!.details.directors.map(c => c.name).join(", ")}`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            </stacklayout>
            <Show when={(p()!.collection?.items.length ?? 0) > 1}>
              <MoreRow
                title={p()!.collection!.name}
                items={p()!.collection!.items.map(i => ({ title: i.title, suggestion: i.suggestion }))}
              />
            </Show>
            {/* Similar titles, minus the ones the series row already shows. */}
            <MoreRow
              title={t("More Like This")}
              items={(p()!.more ?? [])
                .filter(
                  d => !(p()!.collection?.items ?? []).some(c => (c.suggestion?.tmdb_id ?? c.title?.id) === d.tmdb_id),
                )
                .map(suggestion => ({ suggestion }))}
            />
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
            <Facts
              title={t("Languages")}
              facts={[
                {
                  label: t("Original language"),
                  value: p()!.details.original_language
                    ? trackList([{ language: p()!.details.original_language!, detail: null }])
                    : null,
                },
              ]}
            />
            <Facts
              title={t("Files")}
              facts={[
                {
                  label: t("In your library"),
                  value: busy()
                    ? t("Requesting...")
                    : p()!.requested || p()!.downloaded
                      ? (discoverStatus(p()!).label ?? null)
                      : t("Not yet"),
                },
                { label: t("Seasons"), value: p()!.seasons ? String(p()!.seasons) : null },
              ]}
            />
          </Show>
        </stacklayout>
      </scrollview>
    </Show>
  );
}
