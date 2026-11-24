// Libraries whose storage isn't answering (`/api/libraries/offline`, checked every minute by the
// server), as the TV's top bar says: asked every minute while signed in and the page is visible.
import { api } from "@tv/api/client";
import { getToken } from "@tv/api/session";
import { t } from "@tv/i18n";
import { Show, createRoot, createSignal } from "solid-js";

const CHECK_MS = 60_000;
const store = createRoot(() => {
  const [offline, setOffline] = createSignal<string[]>([]);
  return { offline, setOffline };
});
let started = false;
function check() {
  if (!getToken() || document.hidden) return;
  api.offlineLibraries().then(
    (names) => store.setOffline(names),
    () => {},
  );
}

export function OfflineBanner() {
  if (!started) {
    started = true;
    setTimeout(check, 0);
    setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
  }
  return (
    <Show when={store.offline().length}>
      <div class="offline" role="status">
        {t("{names} offline: check the NAS", { names: store.offline().join(", ") })}
      </div>
    </Show>
  );
}
