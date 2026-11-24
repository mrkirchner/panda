// Sign in with a code instead of a password, as on the TV (Link.tsx): the server hands out a
// short code, you approve it at <server>/link from a browser already signed in to Panda, and this
// phone is signed in (and paired) once you do. The code is renewed when it expires.
import { api, HttpError, resetSession } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret, setDeviceSecret, setToken } from "@tv/api/session";
import { t } from "@tv/i18n";
import { Show, createSignal, onCleanup } from "solid-js";
import { afterSignIn } from "../session";
import { platform } from "../platform";

export function linkCodeScreen() {
  const [code, setCode] = createSignal("");
  const [status, setStatus] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
  });

  async function start() {
    try {
      const s = await api.startDeviceSignIn(platform.deviceName(), getDeviceSecret());
      if (!alive) return;
      setCode(s.user_code);
      setStatus(t("On a computer or another phone signed in to Panda, open {url} and enter this code.", {
        url: `${getServer() ?? ""}${s.verification_path}`,
      }));
      poll(s.device_code, s.interval * 1000, Date.now() + s.expires_in * 1000);
    } catch (e) {
      if (!alive) return;
      // Rate limited (too many codes from this network): wait it out.
      if (e instanceof HttpError && e.status === 429) {
        const secs = Number(/(\d+) seconds/.exec(e.message)?.[1] ?? 60);
        setStatus(t("Too many sign-in attempts. Trying again in {min} min.", { min: Math.ceil(secs / 60) }));
        timer = setTimeout(() => void start(), (secs + 1) * 1000);
        return;
      }
      setStatus(t("Can't reach the Panda server at {url}. Retrying...", { url: getServer() ?? "" }));
      timer = setTimeout(() => void start(), 5000);
    }
  }

  function poll(deviceCode: string, interval: number, deadline: number) {
    timer = setTimeout(async () => {
      if (!alive) return;
      if (Date.now() > deadline) return void start();
      try {
        const res = await api.pollDevice(deviceCode);
        if (res.status === "approved") {
          setToken(res.token);
          if (res.device_token) setDeviceSecret(res.device_token);
          resetSession();
          await afterSignIn();
          return;
        }
        if (res.status === "expired") return void start();
      } catch {
        // A network blip: keep asking until the code expires.
      }
      poll(deviceCode, interval, deadline);
    }, interval);
  }

  setTimeout(() => void start(), 0);
  return (
    <stacklayout class="form top">
      <label class="h1" text={t("Sign in with a code")} />
      <Show when={code()} fallback={<activityindicator busy={true} class="mt24" />}>
        <label class="link-code" text={code()} />
      </Show>
      <label class="muted mt10" textWrap={true} text={status()} />
    </stacklayout>
  );
}
