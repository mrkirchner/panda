// Someone from a Cast & Crew row (`/api/people/{id}`): their photo and facts, the biography,
// their titles in your library (big parts first), then their other work by role.
import { api, imageUrl } from "@tv/api/client";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { facts, load, longDate } from "../data";
import { MoreRow } from "./sections";

export function personScreen(id: number) {
  const data = load(() => api.person(id));
  const [open, setOpen] = createSignal(false);
  const p = () => data.value();
  return (
    <scrollview>
      <stacklayout class="home">
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <Show when={p()}>
          <gridlayout class="person-hero" rows="*, auto">
            <image rowSpan={2} class="hero" src={imageUrl(p()!.backdrop)} stretch="aspectFill" />
            <stacklayout rowSpan={2} class="hero-scrim" />
          </gridlayout>
          <stacklayout class="form person-head">
            <gridlayout class="photo">
              <label class="headshot-initial" text={p()!.name.slice(0, 1)} />
              <image class="photo" src={imageUrl(p()!.image)} stretch="aspectFill" />
            </gridlayout>
            <label class="h1" textWrap={true} text={p()!.name} />
            <label
              class="facts"
              textWrap={true}
              text={facts([
                p()!.known_for ? t(p()!.known_for!) : null,
                p()!.birthday ? t("Born {date}", { date: longDate(p()!.birthday) ?? "" }) : null,
                p()!.place_of_birth,
                p()!.deathday ? t("Died {date}", { date: longDate(p()!.deathday) ?? "" }) : null,
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
