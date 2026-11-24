import { createMemo, For, Loading, refresh, Show, useContext } from "solid-js";
import { api } from "../api/client";
import { AdminOnly } from "../components/Frame";
import { Card, ConfirmButton, Notice, useAction } from "../components/ui";
import { ago } from "../format";
import { SessionContext } from "../session";

export default function Devices() {
  return (
    <AdminOnly>
      <DevicesInner />
    </AdminOnly>
  );
}

/** Every signed-in browser and TV across all users. Revoking signs that device out at once. */
function DevicesInner() {
  const session = useContext(SessionContext);
  const sessions = createMemo(() => api.sessions());
  const users = createMemo(() => api.users());
  const name = (id: number) => users().find((u) => u.id === id)?.username ?? `#${id}`;
  const revoke = useAction();

  return (
    <>
      <h1>Devices</h1>
      <TvsCard />
      <Card>
        <p class="muted">
          Every browser and TV signed in to this server. TVs stay signed in while they're used and expire
          after 180 days of inactivity.
        </p>
        <Show when={revoke.error()}>
          <Notice kind="error">{revoke.error()}</Notice>
        </Show>
        <Loading fallback={<p class="muted">Loading...</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Signed in</th>
                  <th>Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <For each={sessions()}>
                  {(s) => (
                    <tr>
                      <td>{name(s.user_id)}</td>
                      <td>
                        {s.name ?? "Unknown"}{" "}
                        <Show when={s.id === session.me()?.session_id}>
                          <span class="badge ok">this browser</span>
                        </Show>
                      </td>
                      <td>{s.kind === "device" ? "TV / device" : "Browser"}</td>
                      <td>{ago(s.created_at)}</td>
                      <td>{ago(s.last_seen_at)}</td>
                      <td>
                        <Show when={s.id !== session.me()?.session_id}>
                          <ConfirmButton
                            label="Sign out"
                            confirm={`Sign out "${s.name ?? "this device"}" for ${name(s.user_id)}?`}
                            onConfirm={() =>
                              revoke.run(() => api.revokeSession(s.id)).then(() => refresh(sessions))
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

/** Paired TVs: each belongs to an account and offers that account's profiles. */
function TvsCard() {
  const tvs = createMemo(() => api.tvs());
  const users = createMemo(() => api.users());
  const owner = (id: number) => {
    const u = users().find((x) => x.id === id);
    return u ? (u.display_name ?? u.username) : `#${id}`;
  };
  const act = useAction();
  const done = () => refresh(tvs);
  return (
    <Card title="TVs">
      <p class="muted">
        A TV belongs to the account that paired it and offers that account's profiles. Forgetting a TV signs
        everyone out and it must be paired again.
      </p>
      <Show when={act.error()}>
        <Notice kind="error">{act.error()}</Notice>
      </Show>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <For each={tvs()} fallback={<p class="muted">No TVs paired yet.</p>}>
          {(tv) => (
            <div class="stack" style={{ "border-top": "1px solid var(--border)", "padding-top": "0.75rem" }}>
              <div class="row" style={{ "justify-content": "space-between" }}>
                <strong>
                  {tv.device.name} <span class="badge">{owner(tv.device.account_id)}'s account</span>
                </strong>
                <span class="muted">Last used {ago(tv.device.last_seen_at)}</span>
                <ConfirmButton
                  label="Forget TV"
                  confirm={`Forget "${tv.device.name}"? Everyone on it is signed out.`}
                  onConfirm={() => void act.run(() => api.forgetTv(tv.device.id)).then(done)}
                />
              </div>
              <span class="muted">
                {tv.profiles
                  .map((p) => (p.display_name ?? p.username) + (p.has_pin ? " (PIN)" : ""))
                  .join(", ")}
              </span>
            </div>
          )}
        </For>
      </Loading>
    </Card>
  );
}
