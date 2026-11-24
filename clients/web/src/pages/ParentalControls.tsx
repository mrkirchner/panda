// Parental controls, as on the TV (../tv/src/pages/ParentalControls.tsx): for the account's
// owner, each profile's age limit behind the account's parental PIN (set once with the owner's
// password). After that the PIN is only asked to leave a limited profile (Who's watching).
import { api, pinMessage } from "@tv/api/client";
import { ageLimitLabel, type AgeLimits } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal, onSettled } from "solid-js";
import { Avatar } from "../components/Avatar";
import { ask, pick } from "../components/ui";
import { message } from "../data";
import { go, paths } from "../nav";

export default function ParentalControls() {
  const [data, setData] = createSignal<AgeLimits | null>(null);
  const [error, setError] = createSignal("");
  /** The parental PIN, once checked (or chosen): changes are sent with it. */
  const [pin, setPin] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal("");
  const [newPin, setNewPin] = createSignal("");
  const [entered, setEntered] = createSignal("");

  const reload = () => api.ageLimits().then(setData, (e: unknown) => setError(message(e)));
  onSettled(() => void reload());

  const unlock = async (e: SubmitEvent) => {
    e.preventDefault();
    try {
      await api.checkParentalPin(entered());
      setPin(entered());
      setError("");
    } catch (err) {
      setError(pinMessage(err));
    }
  };
  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    try {
      await api.setParentalPin(newPin(), { password: password() });
      setPin(newPin());
      setError("");
      await reload();
    } catch (err) {
      setError(pinMessage(err));
    }
  };
  const changePin = async () => {
    const next = await ask(t("Choose a parental PIN"), { input: { type: "pin" } });
    if (!next) return;
    try {
      await api.setParentalPin(next, { pin: pin()! });
      setPin(next);
      setError("");
    } catch (err) {
      setError(pinMessage(err));
    }
  };
  const choose = async (e: MouseEvent, userId: number, current: number | null) => {
    const d = data();
    if (!d) return;
    const options = [...d.limits, null] as (number | null)[];
    const i = await pick(
      t("Age limit"),
      options.map((a) => ({ label: ageLimitLabel(a, t), selected: a === current })),
      e.currentTarget as Element,
    );
    if (i < 0) return;
    try {
      await api.setAgeLimit(userId, options[i], pin()!);
      setError("");
      await reload();
    } catch (err) {
      setError(pinMessage(err));
    }
  };

  return (
    <div class="form-page page-top">
      <h1>{t("Parental controls")}</h1>
      <p class="hint">
        {t(
          "A profile with an age limit only sees titles rated for that age. Leaving it needs the parental PIN.",
        )}
      </p>
      <Show when={data()}>
        {(d) => (
          <>
            {/* First time: the owner's password, then the PIN. */}
            <Show when={!d().has_parental_pin && pin() === null}>
              <form class="form-section" onSubmit={(e) => void create(e)}>
                <p class="hint">
                  {t(
                    "Type your password to choose a parental PIN. It's asked to change age limits and to leave a profile that has one.",
                  )}
                </p>
                <label class="field">
                  <span>{t("Your password")}</span>
                  <input
                    class="input"
                    type="password"
                    autocomplete="current-password"
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                </label>
                <label class="field">
                  <span>{t("Choose a parental PIN")}</span>
                  <input
                    class="input"
                    inputmode="numeric"
                    pattern="[0-9]{4,8}"
                    maxlength={8}
                    value={newPin()}
                    onInput={(e) => setNewPin(e.currentTarget.value.replace(/\D/g, ""))}
                  />
                </label>
                <div class="actions">
                  <button class="btn primary" type="submit" disabled={!password() || newPin().length < 4}>
                    {t("Set PIN")}
                  </button>
                </div>
              </form>
            </Show>
            {/* Set up: the PIN, once per visit. */}
            <Show when={d().has_parental_pin && pin() === null}>
              <form class="form-section" onSubmit={(e) => void unlock(e)}>
                <label class="field">
                  <span>{t("Parental PIN")}</span>
                  <input
                    class="input"
                    type="password"
                    inputmode="numeric"
                    maxlength={8}
                    value={entered()}
                    onInput={(e) => setEntered(e.currentTarget.value.replace(/\D/g, ""))}
                  />
                </label>
                <div class="actions">
                  <button class="btn primary" type="submit" disabled={entered().length < 4}>
                    {t("Continue")}
                  </button>
                </div>
              </form>
            </Show>
            <Show when={pin() !== null}>
              <For each={d().profiles}>
                {(p) => (
                  <div class="form-section setting-row">
                    <Avatar name={p.name} picture={p.avatar} size={48} />
                    <div class="grow">
                      <b>{p.name}</b>
                    </div>
                    <button class="chip" onClick={(e) => void choose(e, p.user_id, p.max_age)}>
                      {ageLimitLabel(p.max_age, t)}
                    </button>
                  </div>
                )}
              </For>
              <Show when={d().profiles.length === 0}>
                <p class="hint">{t("Add a profile first (Who's watching).")}</p>
              </Show>
              <div class="actions form-end">
                <button class="btn" onClick={() => void changePin()}>
                  {t("Change parental PIN")}
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <div class="actions form-end">
        <button class="btn primary" onClick={() => go(paths.editProfile)}>
          {t("Done")}
        </button>
      </div>
    </div>
  );
}
