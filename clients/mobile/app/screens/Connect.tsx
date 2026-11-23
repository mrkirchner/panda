// Which Panda server: the ones found on the network (Bonjour), or an address typed in.
import type { TextField } from "@nativescript/core";
import { checkServer, findServers, type FoundServer } from "@tv/api/discover";
import { normalizeServer, setServer } from "@tv/api/server";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { goSignIn } from "../session";

export function Connect() {
  const [found, setFound] = createSignal<FoundServer[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let field: TextField | undefined;

  findServers().then(
    s => setFound(s),
    () => setFound([]),
  );

  const use = (url: string) => {
    setServer(url);
    goSignIn();
  };

  const connect = async () => {
    const typed = field?.text?.trim() ?? "";
    if (!typed) return;
    setError(null);
    setBusy(true);
    try {
      const url = normalizeServer(typed);
      const server = await checkServer(url, 5000);
      if (server) use(server.url);
      else setError(t("No Panda server answered at {address}.", { address: url }));
    } catch {
      setError(t("That isn't a server address."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <scrollview>
      <stacklayout class="form top">
        <label class="h1" text="Panda" />
        <label class="muted" textWrap={true} text={t("Choose your Panda server.")} />
        <Show when={found() === null}>
          <activityindicator busy={true} class="mt24" />
        </Show>
        <For each={found() ?? []}>
          {s => (
            <stacklayout class="row" on:tap={() => use(s.url)}>
              <label class="h2" text={s.name} />
              <label class="muted" text={s.url} />
            </stacklayout>
          )}
        </For>
        <label class="muted mt28" text={t("Or enter its address")} />
        <textfield
          ref={(el: TextField) => (field = el)}
          class="input"
          hint="192.168.1.20"
          keyboardType="url"
          autocorrect={false}
          autocapitalizationType="none"
          returnKeyType="go"
          on:returnPress={connect}
        />
        <Show when={error()}>
          <label class="error mt10"  textWrap={true} text={error() ?? ""} />
        </Show>
        <button class="primary" text={busy() ? t("Connecting...") : t("Connect")} isEnabled={!busy()} on:tap={connect} />
      </stacklayout>
    </scrollview>
  );
}
