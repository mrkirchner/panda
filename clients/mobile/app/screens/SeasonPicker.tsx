// Which seasons, as the TV's SeasonPicker: All, or any of them (checks), then the action
// (Request, Get seasons). Resolves with the seasons, null for all of them, or undefined if the
// sheet was closed without choosing.
import { t } from "@tv/i18n";
import { For, createSignal } from "solid-js";
import { leaveSheet, openSheet } from "../nav";

export function pickSeasons(seasons: number[], title: string, action: string): Promise<number[] | null | undefined> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: number[] | null | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    openSheet(
      () => {
        const [picked, setPicked] = createSignal<Set<number>>(new Set());
        const all = () => picked().size === 0 || picked().size === seasons.length;
        const toggle = (n: number) =>
          setPicked(prev => {
            const next = new Set(prev);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            return next;
          });
        return (
          <scrollview>
            <stacklayout class="form sheet-form">
              <label class="h2" textWrap={true} text={title} />
              <gridlayout class="row" columns="*, auto" on:tap={() => setPicked(new Set<number>())}>
                <label col={0} class="body" text={t("All seasons")} />
                <label col={1} class="check" text={all() ? "✓" : ""} />
              </gridlayout>
              <For each={seasons}>
                {n => (
                  <gridlayout class="row" columns="*, auto" on:tap={() => toggle(n)}>
                    <label col={0} class="body" text={t("Season {n}", { n })} />
                    <label col={1} class="check" text={picked().has(n) ? "✓" : ""} />
                  </gridlayout>
                )}
              </For>
              <button
                class="primary"
                text={action}
                on:tap={() => {
                  const choice = all() ? null : [...picked()].sort((a, b) => a - b);
                  finish(choice);
                  leaveSheet(() => {});
                }}
              />
            </stacklayout>
          </scrollview>
        );
      },
      () => finish(undefined),
    );
  });
}
