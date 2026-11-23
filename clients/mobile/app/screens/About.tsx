// About Panda: where its information comes from, with the credit each provider's terms ask for
// (TMDB's logo and notice among them), as the TV's About page (`/api/credits`).
import { Screen } from "@nativescript/core";
import { api } from "@tv/api/client";
import type { Credit } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";

export function aboutScreen() {
  const credits = load(() => api.credits().catch(() => [] as Credit[]));
  const logoW = Math.min(240, Screen.mainScreen.widthDIPs - 48);
  return (
    <scrollview>
      <stacklayout class="form">
        <label
          class="muted"
          textWrap={true}
          text={t("Titles, artwork, episodes and ratings come from these services:")}
        />
        <For each={credits.value() ?? []}>
          {c => (
            <stacklayout class="credit">
              <Show when={c.id === "tmdb"} fallback={<label class="h2" text={c.name} />}>
                <image
                  src="~/images/tmdb.png"
                  width={logoW}
                  height={Math.round((logoW * 35.52) / 273.42)}
                  horizontalAlignment="left"
                />
              </Show>
              <label class="body mt8" textWrap={true} text={c.credit} />
              <label class="muted" text={c.site.replace(/^https?:\/\/(www\.)?/, "")} />
            </stacklayout>
          )}
        </For>
      </stacklayout>
    </scrollview>
  );
}
