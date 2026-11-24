import { createMemo, createSignal, For, Loading, refresh, Show, useContext } from "solid-js";
import { api } from "../api/client";
import { Card, ConfirmButton, Notice, useAction } from "../components/ui";
import { ago, passwordProblem } from "../format";
import { SessionContext } from "../session";

export default function Account() {
  const session = useContext(SessionContext);
  const sessions = createMemo(() => api.mySessions());
  const [problem, setProblem] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const pw = useAction();
  const revoke = useAction();

  const changePassword = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    const next = String(f.get("new"));
    const p = passwordProblem(next, String(f.get("confirm")));
    setProblem(p);
    setDone(false);
    if (p) return;
    if (await pw.run(() => api.changePassword(String(f.get("current")), next))) {
      form.reset();
      setDone(true);
      refresh(sessions);
    }
  };

  return (
    <>
      <h1>Account</h1>
      <Card title="Change password">
        <p class="muted">Changing your password signs you out everywhere else, including TVs.</p>
        <form class="stack" onSubmit={changePassword} style={{ "max-width": "380px" }}>
          <label>
            Current password
            <input name="current" type="password" autocomplete="current-password" required />
          </label>
          <label>
            New password
            <input name="new" type="password" autocomplete="new-password" required />
          </label>
          <label>
            Confirm new password
            <input name="confirm" type="password" autocomplete="new-password" required />
          </label>
          <Show when={problem() ?? pw.error()}>
            <Notice kind="error">{problem() ?? pw.error()}</Notice>
          </Show>
          <Show when={done()}>
            <Notice kind="ok">Password changed. Other sessions were signed out.</Notice>
          </Show>
          <button class="primary" disabled={pw.busy()}>
            Change password
          </button>
        </form>
      </Card>
      <PinCard />
      <Card title="Where you're signed in">
        <Loading fallback={<p class="muted">Loading...</p>}>
          <Show when={revoke.error()}>
            <Notice kind="error">{revoke.error()}</Notice>
          </Show>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <For each={sessions()}>
                  {(s) => (
                    <tr>
                      <td>
                        {s.name ?? "Unknown"}{" "}
                        <Show when={s.id === session.me()?.session_id}>
                          <span class="badge ok">this browser</span>
                        </Show>
                      </td>
                      <td>{s.kind === "device" ? "TV / device" : "Browser"}</td>
                      <td>{ago(s.last_seen_at)}</td>
                      <td>
                        <Show when={s.id !== session.me()?.session_id}>
                          <ConfirmButton
                            label="Sign out"
                            confirm={`Sign out "${s.name ?? "this device"}"?`}
                            onConfirm={() =>
                              revoke.run(() => api.revokeMySession(s.id)).then(() => refresh(sessions))
                            }
                          />
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Loading>
      </Card>
    </>
  );
}

/** Optional PIN asked when someone switches to your profile on a shared TV. */
function PinCard() {
  const status = createMemo(() => api.pinStatus());
  const [done, setDone] = createSignal<string | null>(null);
  const act = useAction();

  const save = async (e: SubmitEvent, remove: boolean) => {
    e.preventDefault();
    const form = (e.currentTarget as HTMLElement).closest("form") as HTMLFormElement;
    const f = new FormData(form);
    const pin = remove ? null : String(f.get("pin"));
    if (pin !== null && !/^[0-9]{4,8}$/.test(pin)) {
      act.setError("A PIN is 4 to 8 digits.");
      return;
    }
    setDone(null);
    if (await act.run(() => api.setPin(String(f.get("current")), pin))) {
      form.reset();
      setDone(remove ? "PIN removed." : "PIN saved.");
      refresh(status);
    }
  };

  return (
    <Card title="Profile PIN">
      <p class="muted">
        On a TV shared with others, switching to your profile asks for this PIN. It's checked by the server
        and stored hashed, like your password.
      </p>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <p>
          {status().has_pin ? (
            <span class="badge ok">PIN set</span>
          ) : (
            <span class="muted">No PIN: anyone at your TV can switch to your profile.</span>
          )}
        </p>
        <form class="stack" onSubmit={(e) => void save(e, false)} style={{ "max-width": "380px" }}>
          <label>
            {status().has_pin ? "New PIN" : "PIN"}
            <input
              name="pin"
              type="password"
              inputmode="numeric"
              autocomplete="off"
              maxlength="8"
              placeholder="4-8 digits"
            />
          </label>
          <label>
            Your password
            <input name="current" type="password" autocomplete="current-password" required />
          </label>
          <Show when={act.error()}>
            <Notice kind="error">{act.error()}</Notice>
          </Show>
          <Show when={done()}>
            <Notice kind="ok">{done()}</Notice>
          </Show>
          <div class="row">
            <button class="primary" disabled={act.busy()}>
              {status().has_pin ? "Change PIN" : "Set PIN"}
            </button>
            <Show when={status().has_pin}>
              <button
                type="button"
                class="danger"
                disabled={act.busy()}
                onClick={(e) => void save(e as unknown as SubmitEvent, true)}
              >
                Remove PIN
              </button>
            </Show>
          </div>
        </form>
      </Loading>
    </Card>
  );
}
