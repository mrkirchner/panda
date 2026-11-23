// Username (or email) and password, as on the TV (`/api/auth/device/login`): this phone becomes
// one of the account's devices, so it can switch between the account's profiles.
import { Device, type TextField } from "@nativescript/core";
import { api, HttpError } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret, setDeviceSecret, setToken } from "@tv/api/session";
import { t } from "@tv/i18n";
import { Show, createSignal } from "solid-js";
import { open } from "../nav";
import { afterSignIn } from "../session";
import { Connect } from "./Connect";

export function SignIn() {
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let user: TextField | undefined;
  let pass: TextField | undefined;

  const signIn = async () => {
    const username = user?.text?.trim() ?? "";
    const password = pass?.text ?? "";
    if (!username || !password) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.deviceLogin(username, password, Device.model || "iPhone", getDeviceSecret());
      setToken(res.token);
      if (res.device_token) setDeviceSecret(res.device_token);
      await afterSignIn();
    } catch (e) {
      setError(
        e instanceof HttpError && e.status === 401
          ? t("Wrong username or password.")
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <scrollview>
      <stacklayout class="form top">
        <label class="h1" text={t("Sign in")} />
        <label class="muted" textWrap={true} text={getServer() ?? ""} />
        <textfield
          ref={(el: TextField) => (user = el)}
          class="input"
          hint={t("Username or email")}
          autocorrect={false}
          autocapitalizationType="none"
          returnKeyType="next"
          on:returnPress={() => pass?.focus()}
        />
        <textfield
          ref={(el: TextField) => (pass = el)}
          class="input"
          hint={t("Password")}
          secure={true}
          returnKeyType="go"
          on:returnPress={signIn}
        />
        <Show when={error()}>
          <label class="error mt10"  textWrap={true} text={error() ?? ""} />
        </Show>
        <button class="primary" text={busy() ? t("Signing in...") : t("Sign in")} isEnabled={!busy()} on:tap={signIn} />
        <button class="secondary" text={t("Another server")} on:tap={() => open(() => <Connect />, { clear: true })} />
      </stacklayout>
    </scrollview>
  );
}
