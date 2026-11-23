// A movie: backdrop, facts, overview, and Play (or Resume).
import { api, imageUrl } from "@tv/api/client";
import { t } from "@tv/i18n";
import { Show } from "solid-js";
import { facts, load, runtime } from "../data";
import { play } from "../player";

export function titleScreen(id: string) {
  const data = load(() => api.title(id));
  const details = load(() => api.titleDetails(id).catch(() => null));

  const resumeAt = () => {
    const p = data.value()?.progress;
    return p && !p.finished && p.position_secs > 30 ? p.position_secs : 0;
  };
  const start = (at: number) =>
    play({ kind: "title", id }, at).catch(e => console.log(`play failed: ${String(e)}`));

  return (
    <scrollview>
      <stacklayout>
        <Show when={data.error()}>
          <label class="error form" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <Show when={data.value()}>
          <image class="hero" src={imageUrl(data.value()!.backdrop)} stretch="aspectFill" />
          <stacklayout class="form">
            <label class="h1" textWrap={true} text={data.value()!.title} />
            <label
              class="facts"
              textWrap={true}
              text={facts([
                data.value()!.year,
                details.value()?.certification,
                runtime(data.value()!.duration_secs),
                data.value()!.rating ? `★ ${data.value()!.rating!.toFixed(1)}` : null,
              ])}
            />
            <label class="facts" textWrap={true} text={(data.value()!.genres ?? "").split(/,\s*/).join(", ")} />
            <Show
              when={resumeAt() > 0}
              fallback={<button class="primary" text={t("Play")} on:tap={() => start(0)} />}
            >
              <button
                class="primary"
                text={t("Resume from {time}", { time: runtime(resumeAt()) })}
                on:tap={() => start(resumeAt())}
              />
              <button class="secondary" text={t("Play from the start")} on:tap={() => start(0)} />
            </Show>
            <Show when={details.value()?.tagline}>
              <label class="body accent mt24" textWrap={true} text={details.value()!.tagline ?? ""} />
            </Show>
            <label class="overview" textWrap={true} text={data.value()!.overview ?? ""} />
            <Show when={details.value()?.cast.length}>
              <label class="section-title flush" text={t("Cast")} />
              <label
                class="muted"
                textWrap={true}
                text={details
                  .value()!
                  .cast.slice(0, 8)
                  .map(c => (c.role ? `${c.name} (${c.role})` : c.name))
                  .join(", ")}
              />
            </Show>
          </stacklayout>
        </Show>
      </stacklayout>
    </scrollview>
  );
}
