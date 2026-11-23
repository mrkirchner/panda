// A title you don't have (from More Like This, a person's page or Search), laid out like your own
// (`/api/discover/{kind}/{tmdb_id}`): backdrop, logo, facts, ratings, Request (or how the request is
// going, and Cancel while nothing has come of it), its film series, More Like This, Cast & Crew,
// Information. In your library after all: its real page instead.
import { useParams } from "@solidjs/router";
import { api } from "@tv/api/client";
import type { Preview } from "@tv/api/types";
import { longDate, tmdbRating } from "@tv/format";
import { t } from "@tv/i18n";
import { Show, createEffect, createSignal } from "solid-js";
import { Art, GhostRow, Logo } from "../components/cards";
import { Icon } from "../components/icons";
import { pickSeasons } from "../components/seasons";
import { Credits, Facts, MoreRow, PeopleRow, Ratings, trackList } from "../components/sections";
import { facts, genres, load, message, refreshAll, runtime } from "../data";
import { go, paths } from "../nav";
import { bestProgress, discoverStatus, refreshRequests, requestFor } from "../requests";

function PreviewView(props: { kind: "movie" | "series"; tmdbId: number }) {
  const data = load<Preview>(() => api.preview(props.kind, props.tmdbId));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const p = () => data.value();

  // In the library after all: its own page.
  createEffect(
    () => p()?.library,
    (lib) => {
      if (lib) go(props.kind === "movie" ? paths.title(lib) : paths.series(lib), { replace: true });
    },
  );

  const request = async () => {
    const i = p();
    if (!i?.can_request || busy()) return;
    let seasons: number[] | null = null;
    if (i.kind === "series" && (i.seasons ?? 0) > 1) {
      const chosen = await pickSeasons(
        Array.from({ length: i.seasons! }, (_, n) => n + 1),
        i.title,
        t("Request"),
      );
      if (chosen === undefined) return;
      seasons = chosen;
    }
    setBusy(true);
    setError("");
    try {
      await api.request(i, seasons);
      await refreshRequests();
      data.reload();
      refreshAll();
    } catch (e) {
      setError(message(e));
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
      setError(message(e));
    }
  };

  return (
    <>
      <Show when={data.error()}>
        <p class="empty error" style={{ "padding-top": "calc(var(--topbar-h) + 32px)" }}>
          {data.error()}
        </p>
      </Show>
      <Show
        when={p()}
        fallback={
          <Show when={!data.error()}>
            <div class="ghost ghost-hero" />
            <GhostRow />
          </Show>
        }
      >
        {(pp) => (
          <>
            <section class="detail-hero">
              <Art image={pp().backdrop} alt="" eager />
              <div class="scrim-left" />
              <div class="detail-body">
                <div class="detail-main">
                  <Show when={pp().details.logo} fallback={<h1 class="detail-title">{pp().title}</h1>}>
                    <Logo image={pp().details.logo} title={pp().title} />
                  </Show>
                  <span class="facts-line">
                    {facts([
                      pp().year,
                      pp().seasons
                        ? t("{n} seasons", { n: pp().seasons! })
                        : runtime((pp().runtime_mins ?? 0) * 60),
                      pp().details.certification,
                      genres(pp().genres, 3),
                    ])}
                  </span>
                  <Ratings
                    ratings={pp().details.ratings?.length ? pp().details.ratings! : tmdbRating(pp().rating)}
                  />
                  <Show when={pp().details.next_episode}>
                    {(n) => (
                      <span class="status-line">
                        {t("Next: S{s} E{e}, {date}", {
                          s: n().season,
                          e: n().episode,
                          date: longDate(n().air_date) ?? t("soon"),
                        })}
                      </span>
                    )}
                  </Show>
                  <span class="muted">{t("Not in your library")}</span>
                  <Show when={pp().details.tagline}>
                    <p class="tagline">{pp().details.tagline}</p>
                  </Show>
                  <p class="overview clamp">{pp().overview ?? ""}</p>
                  <div class="actions">
                    <Show when={discoverStatus(pp()).label}>
                      <button
                        class={["btn", discoverStatus(pp()).action ? "primary" : "glass"]}
                        disabled={!discoverStatus(pp()).action || busy()}
                        onClick={() => void request()}
                      >
                        <Show when={discoverStatus(pp()).action}>
                          <Icon name="download" size={20} />
                        </Show>
                        {busy() ? t("Requesting...") : discoverStatus(pp()).label}
                      </button>
                    </Show>
                    <Show when={cancellable()}>
                      <button class="btn glass" onClick={() => void cancel()}>
                        {t("Cancel request")}
                      </button>
                    </Show>
                  </div>
                  <Show when={error()}>
                    <p class="error">{error()}</p>
                  </Show>
                </div>
                <Credits
                  cast={pp().details.cast}
                  directors={pp().details.directors}
                  createdBy={pp().kind === "series"}
                />
              </div>
            </section>
            <Show when={(pp().collection?.items.length ?? 0) > 1}>
              <MoreRow
                title={pp().collection!.name}
                items={pp().collection!.items.map((i) => ({ title: i.title, suggestion: i.suggestion }))}
              />
            </Show>
            <MoreRow
              title={t("More Like This")}
              items={(pp().more ?? [])
                .filter(
                  (d) =>
                    !(pp().collection?.items ?? []).some(
                      (c) => (c.suggestion?.tmdb_id ?? c.title?.id) === d.tmdb_id,
                    ),
                )
                .map((suggestion) => ({ suggestion }))}
            />
            <PeopleRow people={[...pp().details.directors, ...pp().details.cast]} />
            <div class="section facts-grid">
              <Facts
                title={t("Information")}
                facts={[
                  {
                    label: pp().kind === "series" ? t("Network") : t("Studio"),
                    value: pp().details.studios.join(", "),
                  },
                  {
                    label: pp().kind === "series" ? t("First aired") : t("Released"),
                    value: longDate(pp().details.release_date),
                  },
                  { label: t("Rated"), value: pp().details.certification },
                  { label: t("Status"), value: pp().details.status },
                  { label: t("Region of origin"), value: pp().details.countries?.join(", ") },
                ]}
              />
              <Facts
                title={t("Languages")}
                facts={[
                  {
                    label: t("Original language"),
                    value: pp().details.original_language
                      ? trackList([{ language: pp().details.original_language!, detail: null }])
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
                      : pp().requested || pp().downloaded
                        ? (discoverStatus(pp()).label ?? null)
                        : t("Not yet"),
                  },
                  { label: t("Seasons"), value: pp().seasons ? String(pp().seasons) : null },
                ]}
              />
            </div>
          </>
        )}
      </Show>
    </>
  );
}

export default function PreviewPage() {
  const params = useParams<{ kind: string; id: string }>();
  return (
    <Show when={params.id} keyed>
      {(id) => <PreviewView kind={params.kind === "series" ? "series" : "movie"} tmdbId={Number(id)} />}
    </Show>
  );
}
