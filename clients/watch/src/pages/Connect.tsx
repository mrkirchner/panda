// Which Panda server (the standalone build, hosted somewhere other than the server): its address,
// checked (`/api/info`) before it's kept, as the TV's Connect screen.
import { getServer, normalizeServer, setServer } from "@tv/api/server";
import { setDeviceSecret, setToken } from "@tv/api/session";
import { t } from "@tv/i18n";
import { Show, createSignal } from "solid-js";
import { resetStores } from "../features";
import { go } from "../nav";

export default function Connect() {
  const [address, setAddress] = createSignal(() => getServer() ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const url = normalizeServer(address());
      const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const info = (await res.json()) as { name?: string };
      if (!info || typeof info !== "object") throw new Error("not Panda");
      if (url !== getServer()) {
        // Another server: this browser's sign-in there starts over.
        setToken(null);
        setDeviceSecret(null);
      }
      setServer(url);
      resetStores();
      go("/sign-in", { replace: true });
    } catch {
      setError(t("No Panda server answered at that address."));
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
        <h1>{t("Connect to your server")}</h1>
        <p class="lede">{t("Its address, like 192.168.1.20 or panda.example.com.")}</p>
        <div class="field">
          <label for="server">{t("Server address")}</label>
          <input
            id="server"
            class="input"
            inputmode="url"
            autocapitalize="none"
            autocomplete="url"
            value={address()}
            onInput={(e) => setAddress(e.currentTarget.value)}
          />
        </div>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button class="btn primary block" type="submit" disabled={busy() || !address().trim()}>
          {busy() ? t("Connecting...") : t("Connect")}
        </button>
      </form>
    </div>
  );
}
