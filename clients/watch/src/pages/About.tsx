// About Panda, as on the TV: where the information comes from, with the credit each provider's
// terms ask for (TMDB's logo and words), and the licenses.
import { api } from "@tv/api/client";
import type { Credit } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";

export default function About() {
  const credits = load(() => api.credits().catch(() => [] as Credit[]));
  return (
    <div class="form-page" style={{ "padding-top": "calc(var(--topbar-h) + 16px)" }}>
      <h1>{t("About Panda")}</h1>
      <p class="muted">{t("Titles, artwork, episodes and ratings come from these services:")}</p>
      <For each={credits.value() ?? []}>
        {(c) => (
          <div class="form-section setting-row" style={{ "justify-content": "flex-start" }}>
            <Show when={c.id === "tmdb"}>
              <img
                src={`${import.meta.env.BASE_URL}images/tmdb.svg`}
                alt="TMDB"
                style={{ height: "14px", width: "auto" }}
              />
            </Show>
            <div>
              <a href={c.site} target="_blank" rel="noreferrer">
                <b>{c.name}</b>
              </a>
              <div class="muted" style={{ "font-size": "14px" }}>
                {c.credit}
              </div>
            </div>
          </div>
        )}
      </For>
      <p class="muted" style={{ "margin-top": "24px" }}>
        {t(
          "Panda is open source under the Apache License 2.0. It uses FFmpeg (LGPL/GPL), Roboto (Apache 2.0) and Noto Sans (SIL OFL 1.1). Full credits and licenses: LEGAL.md in the source.",
        )}
      </p>
    </div>
  );
}
