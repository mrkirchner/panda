// Who's watching: the account's profiles in this browser (its device credential lists them), as
// on the TV: pick one to watch (its PIN first, if it has one), add one (up to the account's
// limit), or edit one (signs in as it first). Sign out of this browser at the bottom.
import { useSearchParams } from "@solidjs/router";
import { api, ensureSession, HttpError, needsParentalPin, pinMessage } from "@tv/api/client";
import { currentUser, setDeviceSecret, setToken } from "@tv/api/session";
import type { DeviceProfile } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/icons";
import { ask } from "../components/ui";
import { load, message } from "../data";
import { go, href, nextPath, paths } from "../nav";
import { profileChanged, signOutBrowser } from "../session";

/** The server's per-account limit (MAX_PROFILES). */
const MAX_PROFILES = 8;

export default function Profiles() {
  const [search] = useSearchParams<{ next?: string }>();
  // This browser was removed from the account (401): forget it and sign in again (the TV's rule).
  const data = load(() =>
    api.deviceProfiles().catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 401) {
        setDeviceSecret(null);
        setToken(null);
        go(`/sign-in${search.next ? `?next=${encodeURIComponent(search.next)}` : ""}`, { replace: true });
      }
      throw e;
    }),
  );
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal("");

  const pick = async (p: DeviceProfile) => {
    // Editing yourself: no switch and no PIN (the TV's way).
    if (editing() && p.user_id === currentUser()?.id) return go(paths.editProfile);
    let pin: string | undefined;
    if (p.has_pin) {
      const r = await ask(p.display_name || p.username, {
        message: t("Enter PIN"),
        input: { type: "pin" },
      });
      if (r === null) return;
      pin = r;
    }
    let parental: string | undefined;
    for (;;) {
      try {
        const res = await api.switchProfile(p.user_id, pin, parental);
        setToken(res.token);
        profileChanged();
        await ensureSession();
        go(editing() ? paths.editProfile : nextPath(search.next), { replace: !editing() });
        return;
      } catch (e) {
        // Leaving a profile with an age limit: the parental PIN, then the switch again.
        if (!needsParentalPin(e) || parental !== undefined) return void setError(pinMessage(e));
        const r = await ask(t("Parental PIN"), { message: t("Enter PIN"), input: { type: "pin" } });
        if (r === null) return;
        parental = r;
      }
    }
  };

  /** A new profile (no password of its own), then straight to its Edit page for its picture. */
  const add = async () => {
    const name = (
      await ask(t("Add profile"), { input: { type: "text", placeholder: t("Name") }, ok: t("Add") })
    )
      ?.trim()
      .slice(0, 32);
    if (!name) return;
    try {
      const user = await api.createDeviceProfile(name);
      const res = await api.switchProfile(user.id);
      setToken(res.token);
      profileChanged();
      await ensureSession();
      go(paths.editProfile);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div class="profiles-page">
      <h1>{editing() ? t("Choose a profile to edit") : t("Who's watching?")}</h1>
      <Show when={data.error() || error()}>
        <p class="error">{error() || data.error()}</p>
      </Show>
      <div class="profiles">
        <For each={data.value()?.profiles ?? []}>
          {(p) => (
            <button class="profile-cell" onClick={() => void pick(p)}>
              <Avatar name={p.display_name || p.username} picture={p.avatar} size={140} />
              <span>{p.display_name || p.username}</span>
              <Show when={editing() || p.has_pin}>
                <span class="tag">{editing() ? t("Edit") : t("PIN")}</span>
              </Show>
            </button>
          )}
        </For>
        <Show when={!editing() && data.value() && data.value()!.profiles.length < MAX_PROFILES}>
          <button class="profile-cell" onClick={() => void add()}>
            <span class="add-tile">
              <Icon name="plus" size={40} />
            </span>
            <span>{t("Add profile")}</span>
          </button>
        </Show>
        <Show when={!data.value() && !data.error()}>
          <For each={[0, 1, 2]}>
            {() => (
              <span class="profile-cell">
                <span class="ghost add-tile" style={{ border: "0" }} />
              </span>
            )}
          </For>
        </Show>
      </div>
      <div class="actions center">
        <button class={["btn", { primary: editing() }]} onClick={() => setEditing((e) => !e)}>
          {editing() ? t("Done") : t("Edit profiles")}
        </button>
        <Show when={!editing()}>
          <a class="btn" href={href("/about")}>
            {t("About")}
          </a>
        </Show>
        <button class="btn" onClick={signOutBrowser}>
          {t("Sign out of this browser")}
        </button>
      </div>
    </div>
  );
}
