// Libraries whose storage is offline right now (`/api/libraries/offline`), checked every minute
// as the TV's top bar does, shown as a banner on Home, Movies and Shows.
import { api } from "@tv/api/client";
import { t } from "@tv/i18n";
import { Show, createRoot, createSignal } from "solid-js";

const CHECK_MS = 60_000;
const store = createRoot(() => {
  const [names, setNames] = createSignal<string[]>([]);
  return { names, setNames };
});
let started = false;
function check() {
  api.offlineLibraries().then(
    n => store.setNames(n),
    () => {},
  );
}

/** "Movies offline: check the NAS" (nothing when every library answers). */
export function OfflineBanner() {
  if (!started) {
    started = true;
    check();
    setInterval(check, CHECK_MS);
  }
  return (
    <Show when={store.names().length}>
      <label
        class="offline-banner"
        textWrap={true}
        text={t("{names} offline: check the NAS", { names: store.names().join(", ") })}
      />
    </Show>
  );
}
