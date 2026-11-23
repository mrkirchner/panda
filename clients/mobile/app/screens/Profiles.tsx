// Who's watching: the account's profiles on this phone (its device credential lists them), as on
// the TV: pick one to watch, add one (up to the account's limit), or edit one. Editing signs in
// as that profile first (its PIN, if it has one), so a profile is only changed as itself.
import { Dialogs } from "@nativescript/core";
import { api, ensureSession, HttpError, resetSession } from "@tv/api/client";
import { setDeviceSecret, setToken } from "@tv/api/session";
import type { DeviceProfile } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { Avatar } from "../avatar";
import { symbol } from "../symbols";
import { load } from "../data";
import { open } from "../nav";
import { goHome, goSignIn } from "../session";
import { editProfileScreen } from "./EditProfile";

/** The server's per-account limit (MAX_PROFILES). */
const MAX_PROFILES = 8;

const openEdit = () => open(() => editProfileScreen(), { title: t("Edit profile") });

export function Profiles() {
  const data = load(() => api.deviceProfiles());
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal("");

  /** Sign in as `p` (PIN first), then watch, or edit it in edit mode. */
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
      resetSession();
      if (editing()) {
        await ensureSession();
        openEdit();
      } else {
        goHome();
      }
    } catch (e) {
      setError(
        e instanceof HttpError && e.status === 403
          ? t("Wrong PIN")
          : e instanceof Error && e.message.includes("Too many")
            ? t("Too many tries. Wait a few minutes.")
            : String(e instanceof Error ? e.message : e),
      );
    }
  };

  /** A new profile (no password of its own), then straight to its Edit page for its picture. */
  const add = async () => {
    const r = await Dialogs.prompt({
      title: t("Add profile"),
      message: t("Name"),
      okButtonText: t("Add"),
      cancelButtonText: t("Cancel"),
    });
    const name = r.text?.trim().slice(0, 32);
    if (!r.result || !name) return;
    try {
      const user = await api.createDeviceProfile(name);
      const res = await api.switchProfile(user.id);
      setToken(res.token);
      resetSession();
      await ensureSession();
      openEdit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <label class="muted center mt10" text={editing() ? t("Choose a profile to edit") : ""} />
        <Show when={data.error() || error()}>
          <label class="error center" textWrap={true} text={error() || data.error() || ""} />
        </Show>
        <flexboxlayout flexWrap="wrap" justifyContent="center" class="mt24">
          <For each={data.value()?.profiles ?? []}>
            {p => (
              <stacklayout class="profile-cell" on:tap={() => void pick(p)}>
                <Avatar name={p.display_name || p.username} picture={p.avatar} size={96} />
                <label class="body center mt8" text={p.display_name || p.username} />
                <Show when={editing() || p.has_pin}>
                  <label class="small center" text={editing() ? t("Edit") : t("PIN")} />
                </Show>
              </stacklayout>
            )}
          </For>
          <Show when={!editing() && (data.value()?.profiles.length ?? MAX_PROFILES) < MAX_PROFILES}>
            <stacklayout class="profile-cell" on:tap={() => void add()}>
              <gridlayout class="add-tile">
                <image loadMode="async" class="add-icon" src={symbol("plus")} tintColor="#f4f1ea" />
              </gridlayout>
              <label class="body center mt8" text={t("Add profile")} />
            </stacklayout>
          </Show>
        </flexboxlayout>
        <button
          class={editing() ? "primary mt40" : "secondary mt40"}
          text={editing() ? t("Done") : t("Edit profiles")}
          on:tap={() => setEditing(e => !e)}
        />
        <button class="secondary" text={t("Sign out of this phone")} on:tap={signOut} />
      </stacklayout>
    </scrollview>
  );
}
