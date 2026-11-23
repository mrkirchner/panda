// Sign this browser in, as the TV's password sign-in (`/api/auth/device/login`: the web login's
// checks and limits): the browser joins the account as a device, and lands on Who's watching
// when the account has several profiles. Served by Panda, a browser already signed in to Panda's
// web pages skips this (session.ts).
import { useSearchParams } from "@solidjs/router";
import { api, landingPath } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret } from "@tv/api/session";
import { t } from "@tv/i18n";
import { Show, createSignal } from "solid-js";
import { message } from "../data";
import { go, href, nextPath } from "../nav";
import { SERVED_BY_PANDA, browserName, signedIn } from "../session";

export default function SignIn() {
  const [search] = useSearchParams<{ next?: string }>();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      signedIn(await api.deviceLogin(username().trim(), password(), browserName(), getDeviceSecret()));
      const landing = await landingPath();
      go(
        landing === "/"
          ? nextPath(search.next)
          : `${landing}${search.next ? `?next=${encodeURIComponent(search.next)}` : ""}`,
        {
          replace: true,
        },
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="center-page">
      <form class="panel" onSubmit={(e) => void submit(e)}>
        <div class="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>Panda</span>
        </div>
        <h1>{t("Sign in")}</h1>
        <p class="muted" style={{ "margin-top": "0" }}>
          {SERVED_BY_PANDA ? t("With your Panda account.") : (getServer() ?? "")}
        </p>
        <div class="field">
          <label for="username">{t("Email or username")}</label>
          <input
            id="username"
            class="input"
            autocomplete="username"
            autocapitalize="none"
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="password">{t("Password")}</label>
          <input
            id="password"
            class="input"
            type="password"
            autocomplete="current-password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button
          class="btn primary block"
          type="submit"
          disabled={busy() || !username().trim() || !password()}
        >
          {busy() ? t("Signing in...") : t("Sign in")}
        </button>
        <Show when={!SERVED_BY_PANDA}>
          <p class="muted" style={{ "text-align": "center", "margin-bottom": "0" }}>
            <a class="link-btn" href={href("/connect")}>
              {t("Another server")}
            </a>
          </p>
        </Show>
      </form>
    </div>
  );
}
