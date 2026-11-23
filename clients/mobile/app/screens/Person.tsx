// Someone from a Cast & Crew row (`/api/people/{id}`): their photo and facts, the biography,
// their titles in your library (big parts first), then their other work by role.
import { api, imageUrl } from "@tv/api/client";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { facts, load, longDate } from "../data";
import { MoreRow } from "./sections";
import { GhostRow } from "./cards";

/** Whole years from `from` to `to` (ISO dates; `to` defaults to today). */
function yearsBetween(from: string, to?: string | null): number | null {
  const a = new Date(`${from}T12:00:00`);
  const b = to ? new Date(`${to}T12:00:00`) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years;
}

export function personScreen(id: number, known?: { name: string; image: string | null }) {
  const data = load(() => api.person(id));
  const [open, setOpen] = createSignal(false);
  const p = () => data.value();
  /** Their age, or at death (the TV's). */
  const age = () => (p()?.birthday ? yearsBetween(p()!.birthday!, p()!.deathday) : null);
  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        {/* The header at once from what the row knew (name, photo); the rest as ghosts until
            TMDB answers. */}
        <gridlayout class={p() ? "person-hero" : "person-hero ghost"} rows="*, auto">
          <image loadMode="async" rowSpan={2} class="hero" src={imageUrl(p()?.backdrop)} stretch="aspectFill" />
          <stacklayout rowSpan={2} class="hero-scrim" />
        </gridlayout>
        <stacklayout class="form person-head">
          <gridlayout class="photo">
            <label class="headshot-initial" text={(p()?.name ?? known?.name ?? "").slice(0, 1)} />
            <image loadMode="async" class="photo" src={imageUrl(p()?.image ?? known?.image)} stretch="aspectFill" />
          </gridlayout>
          <label class="h1" textWrap={true} text={p()?.name ?? known?.name ?? ""} />
          <Show when={!p() && !data.error()}>
            <stacklayout class="ghost ghost-line" />
            <stacklayout class="ghost ghost-text" />
          </Show>
        </stacklayout>
        <Show when={!p() && !data.error()}>
          <GhostRow />
          <GhostRow />
        </Show>
        <Show when={p()}>
          <stacklayout class="form person-facts">
            <label
              class="facts"
              textWrap={true}
              text={facts([
                p()!.known_for ? t(p()!.known_for!) : null,
                p()!.birthday
                  ? t("Born {date}", { date: longDate(p()!.birthday) ?? "" }) +
                    (age() !== null && !p()!.deathday ? ` (${age()})` : "")
                  : null,
                p()!.place_of_birth,
                p()!.deathday
                  ? t("Died {date}", { date: longDate(p()!.deathday) ?? "" }) + (age() !== null ? ` (${age()})` : "")
                  : null,
              ])}
            />
            <Show when={p()!.biography}>
              <label
                class="overview"
                textWrap={true}
                maxLines={open() ? 0 : 6}
                text={p()!.biography ?? ""}
                on:tap={() => setOpen(o => !o)}
              />
              <label class="link mt8" text={open() ? t("Less") : t("Biography")} on:tap={() => setOpen(o => !o)} />
            </Show>
          </stacklayout>
          <MoreRow
            title={t("In your library")}
            items={[...p()!.movies.map(title => ({ title })), ...p()!.shows.map(show => ({ show }))]}
          />
          <For each={p()!.roles}>
            {r => <MoreRow title={t(r.role)} items={r.items.map(suggestion => ({ suggestion }))} />}
          </For>
        </Show>
      </stacklayout>
    </scrollview>
  );
}
