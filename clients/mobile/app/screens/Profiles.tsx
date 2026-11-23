// Who's watching: the account's profiles on this phone (its device credential lists them).
import { Dialogs } from "@nativescript/core";
import { api, HttpError } from "@tv/api/client";
import { setDeviceSecret, setToken } from "@tv/api/session";
import type { DeviceProfile } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show } from "solid-js";
import { load } from "../data";
import { goHome, goSignIn } from "../session";

export function Profiles() {
  const data = load(() => api.deviceProfiles());

  const pick = async (p: DeviceProfile) => {
    let pin: string | undefined;
    if (p.has_pin) {
      const r = await Dialogs.prompt({
        title: p.display_name || p.username,
        message: t("Enter PIN"),
        okButtonText: t("OK"),
        cancelButtonText: t("Cancel"),
        inputType: "number",
      });
      if (!r.result) return;
      pin = r.text;
    }
    try {
      const res = await api.switchProfile(p.user_id, pin);
      setToken(res.token);
      goHome();
    } catch (e) {
      void Dialogs.alert(e instanceof HttpError && e.status === 403 ? t("Wrong PIN.") : String(e));
    }
  };

  const signOut = () => {
    setToken(null);
    setDeviceSecret(null);
    goSignIn();
  };

  return (
    <scrollview>
      <stacklayout class="form">
        <Show when={data.error()}>
          <label class="error" textWrap={true} text={data.error() ?? ""} />
        </Show>
        <flexboxlayout flexWrap="wrap" justifyContent="center" class="mt24">
          <For each={data.value()?.profiles ?? []}>
            {p => (
              <stacklayout class="profile-cell" on:tap={() => pick(p)}>
                <label class="avatar" text={(p.display_name || p.username).slice(0, 1).toUpperCase()} />
                <label class="body center mt8" text={p.display_name || p.username} />
                <Show when={p.has_pin}>
                  <label class="small center" text={t("PIN")} />
                </Show>
              </stacklayout>
            )}
          </For>
        </flexboxlayout>
        <button class="secondary mt40" text={t("Sign out of this phone")} on:tap={signOut} />
      </stacklayout>
    </scrollview>
  );
}
