import { createMemo, createSignal, For, Loading, refresh, Show, useContext } from "solid-js";
import { api } from "../api/client";
import type { LibraryRow, Role, User } from "../api/types";
import { AdminOnly } from "../components/Frame";
import { Card, ConfirmButton, Notice, useAction } from "../components/ui";
import { ago, passwordProblem, until } from "../format";
import { SessionContext } from "../session";

export default function Users() {
  return (
    <AdminOnly>
      <UsersInner />
    </AdminOnly>
  );
}

/** Which libraries an account (all its profiles) may see. None ticked = all of them. */
function LibraryAccess(props: { user: User; libraries: LibraryRow[]; onSaved: () => void }) {
  const [chosen, setChosen] = createSignal<number[]>(() => props.user.libraries ?? []);
  const save = useAction();
  const toggle = (id: number) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div class="stack">
      <span class="muted">
        Choose what {props.user.display_name ?? props.user.username}'s account (every profile in it) can see.
        Leave everything unticked for all libraries.
      </span>
      <div class="row" style={{ "flex-wrap": "wrap" }}>
        <For each={props.libraries}>
          {(l) => (
            <label
              style={{ display: "flex", "flex-direction": "row", "align-items": "center", gap: "0.4rem" }}
            >
              <input type="checkbox" checked={chosen().includes(l.id)} onChange={() => toggle(l.id)} />
              {l.name}
            </label>
          )}
        </For>
      </div>
      <Show when={save.error()}>
        <Notice kind="error">{save.error()}</Notice>
      </Show>
      <div>
        <button
          class="primary"
          disabled={save.busy()}
          onClick={() =>
            void save
              .run(() => api.updateUser(props.user.id, { libraries: chosen() }))
              .then((ok) => ok && props.onSaved())
          }
        >
          Save access
        </button>
      </div>
    </div>
  );
}

function UsersInner() {
  const session = useContext(SessionContext);
  const features = createMemo(() => api.features());
  const users = createMemo(() => api.users());
  /** Accounts (their owners), each with its profiles, owner first. */
  const accounts = createMemo(() =>
    users()
      .filter((u) => u.id === u.account_id)
      .map((owner) => ({
        owner,
        profiles: [owner, ...users().filter((u) => u.account_id === owner.id && u.id !== owner.id)],
      })),
  );
  const shown = (u: User) => u.display_name ?? u.username;
  const libraries = createMemo(() => api.adminLibraries());
  const [accessFor, setAccessFor] = createSignal<number | null>(null);
  const libraryNames = (u: User) =>
    u.libraries?.length
      ? u.libraries.map((id) => libraries().find((l) => l.id === id)?.name ?? `#${id}`).join(", ")
      : "All libraries";
  const invites = createMemo(() => api.invites());
  const [newLink, setNewLink] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [emailedTo, setEmailedTo] = createSignal<string | null>(null);
  const act = useAction();
  const create = useAction();

  const createInvite = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    await create.run(async () => {
      const res = await api.createInvite(
        f.get("role") as Role,
        String(f.get("note") ?? ""),
        Number(f.get("days")),
        String(f.get("email") ?? "").trim(),
      );
      setNewLink(`${location.origin}${res.path}`);
      setEmailedTo(res.sent ? String(f.get("email")) : null);
      setCopied(false);
      form.reset();
      refresh(invites);
    });
  };

  const resetPassword = (id: number, username: string) => {
    const pw = window.prompt(
      `New password for ${username} (at least 10 characters). They'll be signed out everywhere.`,
    );
    if (!pw) return;
    const problem = passwordProblem(pw);
    if (problem) return act.setError(problem);
    act.run(() => api.resetPassword(id, pw));
  };

  const isMe = (id: number) => id === session.me()?.user.id;

  const [linkNote, setLinkNote] = createSignal<string | null>(null);
  /** A profile gets its own sign-in: a one-time link (emailed when mail is set up). */
  const letSignIn = (id: number, name: string) => {
    const email = window.prompt(
      features().mail
        ? `${name}'s email address. They'll get an email with a link to choose their password.`
        : `${name}'s email address (they'll sign in with it). Mail isn't set up, so you'll get a link to send them.`,
    );
    if (!email) return;
    setLinkNote(null);
    void act.run(async () => {
      const r = await api.signInLink(id, email.trim());
      setLinkNote(
        r.sent
          ? `Sent ${name} a sign-in link at ${r.email}.`
          : `Mail isn't set up (Settings), so send ${name} this link yourself: ${location.origin}${r.path}`,
      );
    });
  };

  const setPin = (id: number, username: string) => {
    const pin = window.prompt(`PIN for ${username} on shared TVs (4-8 digits). Leave empty to remove it.`);
    if (pin === null) return;
    if (pin !== "" && !/^[0-9]{4,8}$/.test(pin)) return act.setError("A PIN is 4 to 8 digits.");
    act.run(() => api.setUserPin(id, pin === "" ? null : pin)).then(() => refresh(users));
  };

  return (
    <>
      <h1>Accounts and invites</h1>
      <Show when={act.error()}>
        <Notice kind="error">{act.error()}</Notice>
      </Show>
      <Show when={linkNote()}>
        <Notice kind="ok">{linkNote()}</Notice>
      </Show>

      <Card title="Invite someone">
        <p class="muted">
          Panda has no public sign-up. An invite link creates a new account for someone you share the server
          with: they sign in, pair their own TVs and make their own profiles, and never see yours. Each link
          works once and expires. For your own family, add profiles from "Who's watching?" on your TV instead.
        </p>
        <form class="row" onSubmit={createInvite}>
          <label>
            Role
            <select name="role">
              <option value="user">User (watch and request)</option>
              <option value="admin">Admin (full control)</option>
            </select>
          </label>
          <label style={{ flex: "1" }}>
            Note (who it's for)
            <input name="note" maxlength="100" placeholder="Sam" />
          </label>
          {/* Only with a mail server (Settings); without one, links are shared by hand. */}
          <Loading fallback={null}>
            <Show when={features().mail}>
              <label style={{ flex: "1" }}>
                Email (optional)
                <input name="email" type="email" placeholder="sam@example.com" />
              </label>
            </Show>
          </Loading>
          <label>
            Expires
            <select name="days">
              <option value="1">1 day</option>
              <option value="7" selected>
                7 days
              </option>
              <option value="30">30 days</option>
            </select>
          </label>
          <button class="primary" disabled={create.busy()} style={{ "align-self": "flex-end" }}>
            Create invite link
          </button>
        </form>
        <Show when={create.error()}>
          <Notice kind="error">{create.error()}</Notice>
        </Show>
        <Show when={newLink()}>
          {(link) => (
            <div class="stack" style={{ "margin-top": "1rem" }}>
              <Notice kind="ok">
                {emailedTo()
                  ? `Invite emailed to ${emailedTo()}. The link is also below (it can't be shown again).`
                  : "Invite created. Copy it now: for security, it can't be shown again."}
              </Notice>
              <div class="secret mono">{link()}</div>
              <div>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(link());
                    setCopied(true);
                  }}
                >
                  {copied() ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          )}
        </Show>
      </Card>

      <Card title="Accounts">
        <Loading fallback={<p class="muted">Loading...</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <For each={accounts()}>
                {(a) => (
                  <tbody>
                    <tr>
                      <td colspan="5" style={{ "padding-top": "1rem" }}>
                        <strong>{shown(a.owner)}'s account</strong>{" "}
                        <span class="muted">
                          {a.profiles.length} of 8 profiles | {libraryNames(a.owner)}
                        </span>{" "}
                        <Show when={isMe(a.owner.id)}>
                          <span class="badge">you</span>
                        </Show>
                      </td>
                    </tr>
                    <For each={a.profiles}>
                      {(u) => (
                        <>
                          <tr>
                            <td style={{ "padding-left": u.id === a.owner.id ? undefined : "1.5rem" }}>
                              {shown(u)}{" "}
                              <span class="muted">
                                {u.id === a.owner.id
                                  ? "owner"
                                  : u.managed
                                    ? "profile"
                                    : `profile, signs in${u.email ? ` as ${u.email}` : ""}`}
                              </span>
                            </td>
                            <td>
                              <Show when={!u.managed} fallback={<span class="muted">-</span>}>
                                <select
                                  disabled={isMe(u.id)}
                                  onChange={(e) =>
                                    act
                                      .run(() =>
                                        api.updateUser(u.id, { role: e.currentTarget.value as Role }),
                                      )
                                      .then(() => refresh(users))
                                  }
                                >
                                  <option value="user" selected={u.role === "user"}>
                                    User
                                  </option>
                                  <option value="admin" selected={u.role === "admin"}>
                                    Admin
                                  </option>
                                </select>
                              </Show>
                            </td>
                            <td>
                              <span class={["badge", u.disabled ? "danger" : "ok"]}>
                                {u.disabled ? "disabled" : "active"}
                              </span>
                            </td>
                            <td>{u.managed ? <span class="muted">-</span> : ago(u.last_login_at)}</td>
                            <td>
                              <div class="row">
                                <Show when={!isMe(u.id)}>
                                  <button
                                    onClick={() =>
                                      act
                                        .run(() => api.updateUser(u.id, { disabled: !u.disabled }))
                                        .then(() => refresh(users))
                                    }
                                  >
                                    {u.disabled ? "Enable" : "Disable"}
                                  </button>
                                  <Show when={!u.managed}>
                                    <button onClick={() => resetPassword(u.id, shown(u))}>
                                      Reset password
                                    </button>
                                  </Show>
                                </Show>
                                <button onClick={() => setPin(u.id, shown(u))}>PIN</button>
                                <Show when={u.managed}>
                                  <button onClick={() => letSignIn(u.id, shown(u))}>Let them sign in</button>
                                </Show>
                                <Show when={u.id === a.owner.id && u.role !== "admin"}>
                                  <button
                                    title={libraryNames(u)}
                                    onClick={() => setAccessFor(accessFor() === u.id ? null : u.id)}
                                  >
                                    Libraries
                                  </button>
                                </Show>
                                <Show when={!isMe(u.id) && !(u.id === a.owner.id && isMe(a.owner.id))}>
                                  <ConfirmButton
                                    label={u.id === a.owner.id ? "Delete account" : "Delete"}
                                    confirm={
                                      u.id === a.owner.id
                                        ? `Delete ${shown(u)}'s account? All ${a.profiles.length} of its profiles, their history and its TVs are deleted. This can't be undone.`
                                        : `Delete the profile ${shown(u)}? Its history and My List are deleted.`
                                    }
                                    onConfirm={() =>
                                      act.run(() => api.deleteUser(u.id)).then(() => refresh(users))
                                    }
                                  />
                                </Show>
                              </div>
                            </td>
                          </tr>
                          <Show when={accessFor() === u.id}>
                            <tr>
                              <td colspan="5">
                                <LibraryAccess
                                  user={u}
                                  libraries={libraries()}
                                  onSaved={() => {
                                    setAccessFor(null);
                                    refresh(users);
                                  }}
                                />
                              </td>
                            </tr>
                          </Show>
                        </>
                      )}
                    </For>
                  </tbody>
                )}
              </For>
            </table>
          </div>
        </Loading>
      </Card>

      <Card title="Invites">
        <Loading fallback={<p class="muted">Loading...</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>For</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <For
                  each={invites()}
                  fallback={
                    <tr>
                      <td colspan="4" class="muted">
                        No invites yet.
                      </td>
                    </tr>
                  }
                >
                  {(i) => (
                    <tr>
                      <td>{i.note ?? <span class="muted">(no note)</span>}</td>
                      <td>{i.role}</td>
                      <td>
                        <Show
                          when={i.used_at}
                          fallback={
                            <span class={["badge", i.expires_at * 1000 < Date.now() ? "danger" : "warn"]}>
                              {i.expires_at * 1000 < Date.now()
                                ? "expired"
                                : `unused, expires ${until(i.expires_at)}`}
                            </span>
                          }
                        >
                          <span class="badge ok">used {ago(i.used_at)}</span>
                        </Show>
                      </td>
                      <td>
                        <Show when={!i.used_at}>
                          <ConfirmButton
                            label="Revoke"
                            confirm="Revoke this invite link?"
                            onConfirm={() =>
                              act.run(() => api.deleteInvite(i.id)).then(() => refresh(invites))
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
