// A person (Cast & Crew), laid out like the TV's (`/api/people/{id}`): photo, name, facts, the start
// of the biography (Biography opens it all) over a backdrop from one of their big parts; then
// theirs in your library, and their other work by role. The name and photo the row knew show at
// once while TMDB answers.
import { useParams, useSearchParams } from "@solidjs/router";
import { api, imageUrl } from "@tv/api/client";
import { longDate } from "@tv/format";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { Art, GhostRow } from "../components/cards";
import { MoreRow } from "../components/sections";
import { facts, load } from "../data";

function yearsBetween(from: string, to?: string | null): number | null {
  const a = new Date(`${from}T12:00:00`);
  const b = to ? new Date(`${to}T12:00:00`) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years;
}

function PersonView(props: { id: number; knownName?: string; knownImage?: string }) {
  const data = load(() => api.person(props.id));
  const [open, setOpen] = createSignal(false);
  const p = () => data.value();
  const age = () => (p()?.birthday ? yearsBetween(p()!.birthday!, p()!.deathday) : null);
  const name = () => p()?.name ?? props.knownName ?? "";
  const photo = () => imageUrl(p()?.image ?? props.knownImage);
  return (
    <>
      <section class="detail-hero">
        <Show when={p()?.backdrop}>
          <Art image={p()!.backdrop} alt="" eager />
        </Show>
        <div class="scrim-left" />
        <div class="detail-body">
          <div class="detail-main">
            <div class="person-head">
              <div class="person-photo">
                {name().slice(0, 1)}
                <Show when={photo()}>{(src) => <img src={src()} alt="" />}</Show>
              </div>
              <div class="stack tight">
                <h1 class="detail-title">{name()}</h1>
                <Show when={p()} fallback={<div class="ghost ghost-line" />}>
                  <span class="facts-line">
                    {facts([
                      p()!.known_for ? t(p()!.known_for!) : null,
                      p()!.birthday
                        ? t("Born {date}", { date: longDate(p()!.birthday) ?? "" }) +
                          (age() !== null && !p()!.deathday ? ` (${age()})` : "")
                        : null,
                      p()!.place_of_birth,
                      p()!.deathday
                        ? t("Died {date}", { date: longDate(p()!.deathday) ?? "" }) +
                          (age() !== null ? ` (${age()})` : "")
                        : null,
                    ])}
                  </span>
                </Show>
              </div>
            </div>
            <Show when={data.error()}>
              <p class="error">{data.error()}</p>
            </Show>
            <Show when={p()?.biography}>
              <p class={["overview", { clamp: !open() }]} style={{ "white-space": "pre-line" }}>
                {p()!.biography}
              </p>
              <div>
                <button class="link-btn" onClick={() => setOpen((o) => !o)}>
                  {open() ? t("Less") : t("Biography")}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </section>
      <Show
        when={p()}
        fallback={
          <Show when={!data.error()}>
            <GhostRow />
            <GhostRow />
          </Show>
        }
      >
        <MoreRow
          title={t("In your library")}
          items={[...p()!.movies.map((title) => ({ title })), ...p()!.shows.map((show) => ({ show }))]}
        />
        <For each={p()!.roles}>
          {(r) => <MoreRow title={t(r.role)} items={r.items.map((suggestion) => ({ suggestion }))} />}
        </For>
      </Show>
    </>
  );
}

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const [search] = useSearchParams<{ name?: string; image?: string }>();
  return (
    <Show when={params.id} keyed>
      {(id) => <PersonView id={Number(id)} knownName={search.name} knownImage={search.image || undefined} />}
    </Show>
  );
}
