import { createSignal, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { api } from "../api/client";
import { Card, Notice, useAction } from "../components/ui";

/** Approve the code shown on a TV. The TV then gets its own device token (revocable in Devices). */
export default function Link() {
  const [params] = useSearchParams<{ code: string }>();
  const [paired, setPaired] = createSignal<string | null>(null);
  const { busy, error, run } = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const code = String(new FormData(form).get("code"));
    await run(async () => {
      const res = await api.approveDevice(code);
      setPaired(res.device_name);
      form.reset();
    });
  };

  return (
    <>
      <h1>Pair a TV</h1>
      <Card>
        <p class="muted">
          Open Panda on your TV. It shows a code like <code>K7QM-4PBX</code>. Enter it here.
        </p>
        <form class="stack" onSubmit={submit} style={{ "max-width": "360px" }}>
          <label>
            Code from the TV
            <input
              name="code"
              class="code-big"
              value={params.code ?? ""}
              required
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              maxlength="9"
              placeholder="XXXX-XXXX"
            />
          </label>
          <Show when={error()}>
            <Notice kind="error">{error()}</Notice>
          </Show>
          <Show when={paired()}>
            <Notice kind="ok">Paired "{paired()}". It will sign in within a few seconds.</Notice>
          </Show>
          <button class="primary" disabled={busy()}>
            {busy() ? "Pairing..." : "Pair TV"}
          </button>
        </form>
      </Card>
    </>
  );
}
