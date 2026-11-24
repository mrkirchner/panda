// Parental controls, as on the TV (../tv/src/pages/ParentalControls.tsx): for the account's
// owner, each profile's age limit behind the account's parental PIN (set once with the owner's
// password). After that the PIN is only asked to leave a limited profile (Who's watching).
import { Dialogs } from "@nativescript/core";
import { api, pinMessage } from "@tv/api/client";
import { ageLimitLabel, type AgeLimits } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { open } from "../nav";
import { platform } from "../platform";

const ask = (title: string, kind: "pin" | "password", message?: string) =>
  platform.prompt({ title, message, ok: t("OK"), cancel: t("Cancel"), kind });

/** The PIN first (or setting it up), then the page; nothing opens if that's cancelled. */
export async function openParentalControls(): Promise<void> {
  let limits: AgeLimits;
  try {
    limits = await api.ageLimits();
  } catch (e) {
    return void Dialogs.alert({ title: t("Parental controls"), message: pinMessage(e), okButtonText: t("OK") });
  }
  let pin: string | null;
  try {
    if (limits.has_parental_pin) {
      pin = await ask(t("Parental PIN"), "pin");
      if (pin === null) return;
      await api.checkParentalPin(pin);
    } else {
      const password = await ask(
        t("Your password"),
        "password",
        t("Type your password to choose a parental PIN. It's asked to change age limits and to leave a profile that has one."),
      );
      if (password === null) return;
      pin = await ask(t("Choose a parental PIN"), "pin");
      if (pin === null) return;
      await api.setParentalPin(pin, { password });
    }
  } catch (e) {
    return void Dialogs.alert({ title: t("Parental controls"), message: pinMessage(e), okButtonText: t("OK") });
  }
  open(() => parentalScreen(limits, pin), { title: t("Parental controls") });
}

function parentalScreen(first: AgeLimits, startPin: string) {
  const [data, setData] = createSignal(first);
  const [error, setError] = createSignal("");
  let pin = startPin;
  const reload = () => api.ageLimits().then(setData, () => {});

  const choose = async (userId: number, name: string) => {
    const options = [...data().limits, null] as (number | null)[];
    const labels = options.map((a) => ageLimitLabel(a, t));
    const picked = await Dialogs.action({ title: name, cancelButtonText: t("Cancel"), actions: labels });
    const i = labels.indexOf(picked);
    if (i < 0) return;
    try {
      await api.setAgeLimit(userId, options[i], pin);
      setError("");
      await reload();
    } catch (e) {
      setError(pinMessage(e));
    }
  };
  const changePin = async () => {
    const next = await ask(t("Choose a parental PIN"), "pin");
    if (!next) return;
    try {
      await api.setParentalPin(next, { pin });
      pin = next;
      setError("");
    } catch (e) {
      setError(pinMessage(e));
    }
  };

  return (
    <scrollview>
      <stacklayout class="form">
        <label
          class="muted"
          textWrap={true}
          text={t("A profile with an age limit only sees titles rated for that age. Leaving it needs the parental PIN.")}
        />
        <For each={data().profiles}>
          {(p) => (
            <gridlayout class="row" columns="*, auto" on:tap={() => void choose(p.user_id, p.name)}>
              <label col={0} class="body setting-label" text={p.name} />
              <label col={1} class="muted" text={ageLimitLabel(p.max_age, t)} />
            </gridlayout>
          )}
        </For>
        <Show when={data().profiles.length === 0}>
          <label class="muted mt10" textWrap={true} text={t("Add a profile first (Who's watching).")} />
        </Show>
        <gridlayout class="row" columns="*, auto" on:tap={() => void changePin()}>
          <label col={0} class="body setting-label" text={t("Change parental PIN")} />
        </gridlayout>
        <Show when={error()}>
          <label class="error mt10" textWrap={true} text={error()} />
        </Show>
      </stacklayout>
    </scrollview>
  );
}
