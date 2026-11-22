import { createMemo, createSignal, For, Loading, refresh, Show } from "solid-js";
import { api } from "../api/client";
import type { EpisodeOrders, MatchCandidate, MatchKind, MatchSuspect } from "../api/types";
import { AdminOnly } from "../components/Frame";
import { Card, Notice, useAction } from "../components/ui";
import "./matches.css";

export default function Matches() {
  return (
    <AdminOnly>
      <MatchesInner />
    </AdminOnly>
  );
}

const REASONS: Record<MatchSuspect["reason"], string> = {
  "not matched": "Not matched",
  "different title": "Title differs",
  "different year": "Year differs",
};

/**
 * Titles whose TMDB match looks wrong (or that have none): pick the right one from TMDB. The
 * choice is remembered by the file/folder name, so upgrades and new episodes keep it.
 */
function MatchesInner() {
  const suspects = createMemo(() => api.matchSuspects());
  const [open, setOpen] = createSignal<string | null>(null);
  const key = (s: MatchSuspect) => `${s.kind}:${s.id}`;

  return (
    <>
      <h1>Matches</h1>
      <Card>
        <p class="muted">
          Panda matches files to TMDB by their names. These look wrong (the match's title doesn't resemble the
          file or folder name) or have no match. Fix one to pick the right movie or show: its artwork, details
          and episode names follow, and new files with the same name get the same match. Your files and
          folders are never renamed.
        </p>
        <Loading fallback={<p class="muted">Loading...</p>}>
          <For each={suspects()} fallback={<p class="muted">Nothing looks mismatched.</p>}>
            {(s) => (
              <div class="match-row">
                <div class="row" style={{ "justify-content": "space-between", "align-items": "center" }}>
                  <div class="row" style={{ "align-items": "center", gap: "0.75rem" }}>
                    <Show when={s.matched?.poster} fallback={<div class="match-poster empty" />}>
                      {(p) => <img class="match-poster" src={`/api/images/${p()}`} alt="" />}
                    </Show>
                    <div class="stack" style={{ gap: "0.15rem" }}>
                      <strong>
                        {s.name}
                        <Show when={s.year}>{(y) => <span class="muted"> ({y()})</span>}</Show>
                      </strong>
                      <span class="muted">
                        {s.kind === "series" ? "Show" : "Movie"} ·{" "}
                        {s.matched
                          ? `matched to "${s.matched.title}"${s.matched.year ? ` (${s.matched.year})` : ""}`
                          : "no match"}
                      </span>
                    </div>
                    <span class={["badge", { warn: s.reason !== "not matched" }]}>{REASONS[s.reason]}</span>
                  </div>
                  <button onClick={() => setOpen(open() === key(s) ? null : key(s))}>
                    {open() === key(s) ? "Close" : "Fix"}
                  </button>
                </div>
                <Show when={open() === key(s)}>
                  <Fixer
                    suspect={s}
                    onDone={() => {
                      setOpen(null);
                      refresh(suspects);
                    }}
                  />
                </Show>
              </div>
            )}
          </For>
        </Loading>
      </Card>
      <AnyShow />
    </>
  );
}

/** Search TMDB and pick the right movie or show for one title (shows: then its seasons). */
function Fixer(props: { suspect: MatchSuspect; onDone: () => void }) {
  const act = useAction();
  const pick = (c: MatchCandidate) =>
    void act
      .run(() => api.applyMatch(props.suspect.kind, props.suspect.id, c.tmdb_id))
      .then((ok) => {
        if (ok) props.onDone();
      });

  return (
    <div class="stack" style={{ "margin-top": "0.75rem" }}>
      <Show when={act.error()}>
        <Notice kind="error">{act.error()}</Notice>
      </Show>
      <TmdbPicker kind={props.suspect.kind} initial={props.suspect.name} busy={act.busy()} onPick={pick} />
      <Show when={props.suspect.kind === "series" && props.suspect.matched}>
        <Seasons series={props.suspect.id} />
      </Show>
    </div>
  );
}

/** A TMDB search box with its results as posters; `onPick` gets the chosen one. */
function TmdbPicker(props: {
  kind: MatchKind;
  initial: string;
  busy: boolean;
  onPick: (c: MatchCandidate) => void;
}) {
  const [draft, setDraft] = createSignal(() => props.initial);
  const [query, setQuery] = createSignal<string | null>(null);
  const results = createMemo(() => {
    const q = query();
    return q ? api.searchMatches(props.kind, q) : Promise.resolve<MatchCandidate[]>([]);
  });
  return (
    <div class="stack">
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft().trim() || null);
        }}
      >
        <input value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} placeholder="Search TMDB" />
        <button type="submit">Search</button>
      </form>
      <Show when={query()}>
        <Loading fallback={<p class="muted">Searching TMDB...</p>}>
          <div class="match-results">
            <For each={results()} fallback={<p class="muted">No results. Try another spelling.</p>}>
              {(c) => (
                <button class="match-candidate" disabled={props.busy} onClick={() => props.onPick(c)}>
                  <Show when={c.poster} fallback={<div class="match-poster large empty" />}>
                    {(p) => <img class="match-poster large" src={`/api/images/${p()}`} alt="" />}
                  </Show>
                  <strong>{c.title}</strong>
                  <span class="muted">{c.year ?? "Year unknown"}</span>
                </button>
              )}
            </For>
          </div>
        </Loading>
      </Show>
    </div>
  );
}

/**
 * A show folder's seasons. Sonarr keeps an anthology as one show with a season per story
 * (Monster: S2 Menendez, S3 Ed Gein); TMDB lists each story as its own show. Matching a season
 * takes its episode names, thumbnails and backdrop from that show.
 */
function Seasons(props: { series: string }) {
  const rows = createMemo(() => api.matchSeasons(props.series));
  const [open, setOpen] = createSignal<number | null>(null);
  const [tmdbSeason, setTmdbSeason] = createSignal(1);
  const act = useAction();
  const label = (n: number) => (n === 0 ? "Specials" : `Season ${n}`);
  const pick = (season: number, c: MatchCandidate) =>
    void act
      .run(() => api.applySeasonMatch(props.series, season, c.tmdb_id, tmdbSeason()))
      .then((ok) => {
        if (ok) {
          setOpen(null);
          refresh(rows);
        }
      });
  const undo = (season: number) =>
    void act.run(() => api.clearSeasonMatch(props.series, season)).then(() => refresh(rows));

  return (
    <div class="stack" style={{ "margin-top": "0.5rem" }}>
      <EpisodeOrder series={props.series} onChange={() => refresh(rows)} />
      <strong>Seasons</strong>
      <p class="muted">
        For anthologies TMDB lists as separate shows (each story its own show), match a season to its story:
        its episode names, thumbnails and backdrop come from there.
      </p>
      <Show when={act.error()}>
        <Notice kind="error">{act.error()}</Notice>
      </Show>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <For each={rows()}>
          {(r) => (
            <div class="match-row">
              <div class="row" style={{ "justify-content": "space-between", "align-items": "center" }}>
                <span>
                  <strong>{label(r.season)}</strong>{" "}
                  <span class="muted">
                    · {r.episodes} episode{r.episodes === 1 ? "" : "s"}
                    {r.matched
                      ? ` · from "${r.matched.title}"${r.matched.tmdb_season === 1 ? "" : ` season ${r.matched.tmdb_season}`}`
                      : r.order_part
                        ? ` · TMDB: "${r.order_part}"`
                        : " · the show's own"}
                  </span>
                </span>
                <div class="row">
                  <Show when={r.matched}>
                    <button disabled={act.busy()} onClick={() => undo(r.season)}>
                      Use the show's
                    </button>
                  </Show>
                  <button
                    onClick={() => {
                      setTmdbSeason(1);
                      setOpen(open() === r.season ? null : r.season);
                    }}
                  >
                    {open() === r.season ? "Close" : "Match season"}
                  </button>
                </div>
              </div>
              <Show when={open() === r.season}>
                <div class="stack" style={{ "margin-top": "0.5rem" }}>
                  <div class="row" style={{ "align-items": "center" }}>
                    <label class="muted" for="tmdb-season">
                      Which of its seasons
                    </label>
                    <input
                      id="tmdb-season"
                      type="number"
                      min="0"
                      style={{ width: "5rem" }}
                      value={tmdbSeason()}
                      onInput={(e) => setTmdbSeason(Math.max(0, Number(e.currentTarget.value) || 0))}
                    />
                    <span class="muted">
                      (that show's own season, not this one; ignored for a miniseries)
                    </span>
                  </div>
                  <TmdbPicker
                    kind="series"
                    initial={props.series.replace(/\s*\(\d{4}\)$/, "")}
                    busy={act.busy()}
                    onPick={(c) => pick(r.season, c)}
                  />
                </div>
              </Show>
            </div>
          )}
        </For>
      </Loading>
    </div>
  );
}

/**
 * A show's episode order: TMDB's default seasons, or another order TMDB has for it (DVD,
 * absolute, ...) for a show whose files are numbered that way (often anime). Its episodes are
 * fetched again in the chosen numbering.
 */
function EpisodeOrder(props: { series: string; onChange: () => void }) {
  // A failure here (TMDB unreachable, show not matched yet) only hides the picker: the
  // seasons below keep working.
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const orders = createMemo(() =>
    api.episodeOrders(props.series).catch((e: unknown) => {
      setLoadError(e instanceof Error ? e.message : String(e));
      return { current: null, orders: [] } as EpisodeOrders;
    }),
  );
  const act = useAction();
  const choose = (id: string) =>
    void act
      .run(() => api.setEpisodeOrder(props.series, id || null))
      .then((ok) => {
        if (ok) {
          refresh(orders);
          props.onChange();
        }
      });
  return (
    <div class="stack">
      <strong>Episode order</strong>
      <p class="muted">
        If the files are numbered differently from TMDB's seasons (a DVD or absolute order, common for anime),
        pick the order they follow; episode names and thumbnails are fetched again to match. It applies to the
        whole show, every folder of it.
      </p>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <Show
          when={orders().orders.length > 0}
          fallback={<p class="muted">TMDB has no other orders for this show.</p>}
        >
          <select
            value={orders().current ?? ""}
            disabled={act.busy()}
            onChange={(e) => choose(e.currentTarget.value)}
          >
            <option value="">TMDB's seasons (default)</option>
            <For each={orders().orders}>
              {(o) => (
                <option value={o.id}>
                  {o.name} ({o.kind}, {o.episodes} episodes in {o.seasons} seasons)
                </option>
              )}
            </For>
          </select>
        </Show>
      </Loading>
      <Show when={act.busy()}>
        <p class="muted">Fetching episodes in this order...</p>
      </Show>
      <Show when={act.error() ?? loadError()}>
        <Notice kind="error">{act.error() ?? loadError()}</Notice>
      </Show>
    </div>
  );
}

/** Any show's seasons, for one that's matched right but is an anthology. */
function AnyShow() {
  const shows = createMemo(() => api.series());
  const [chosen, setChosen] = createSignal("");
  return (
    <Card title="Seasons of any show">
      <Loading fallback={<p class="muted">Loading...</p>}>
        <select value={chosen()} onChange={(e) => setChosen(e.currentTarget.value)}>
          <option value="">Choose a show...</option>
          <For each={shows()}>{(s) => <option value={s.series}>{s.series}</option>}</For>
        </select>
      </Loading>
      <Show when={chosen()}>{(name) => <Seasons series={name()} />}</Show>
    </Card>
  );
}
