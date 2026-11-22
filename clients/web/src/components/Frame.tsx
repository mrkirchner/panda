import { Show, useContext, type ParentComponent } from "solid-js";
import { api } from "../api/client";
import type { Me } from "../api/types";
import { SessionContext } from "../session";

/** Signed-in layout: sidebar navigation + content. Admin links only for admins. */
export const Frame: ParentComponent<{ me: Me }> = (props) => {
  const session = useContext(SessionContext);
  const isAdmin = () => props.me.user.role === "admin";
  return (
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          Panda
        </div>
        <Show when={isAdmin()}>
          <a href="/">Dashboard</a>
          <a href="/libraries">Libraries</a>
          <a href="/matches">Matches</a>
          <a href="/settings">Settings</a>
          <a href="/users">Users and invites</a>
          <a href="/devices">Devices</a>
        </Show>
        <a href="/account">Account</a>
        <div class="spacer" />
        {/* Actions, apart from the pages above. */}
        <a href="/link">Pair a TV</a>
        {/* The TV app in this browser (served by Panda at /tv/; it signs in from this session).
            A new tab, and a full page load: the router leaves target="_blank" links alone. */}
        <a href="/tv/" target="_blank" rel="noopener">
          Open the TV app ↗
        </a>
        <div class="who">
          Signed in as <strong>{props.me.user.username}</strong>
        </div>
        <button
          class="link"
          style={{ "text-align": "left", padding: "0 0.75rem" }}
          onClick={async () => {
            await api.logout().catch(() => {});
            session.reload();
          }}
        >
          Sign out
        </button>
      </nav>
      <main>{props.children}</main>
    </div>
  );
};

/** Wrap admin pages: non-admins see a message instead of a broken page. */
export const AdminOnly: ParentComponent = (props) => {
  const session = useContext(SessionContext);
  return (
    <Show
      when={session.me()?.user.role === "admin"}
      fallback={
        <p class="muted">
          This page is for admins. You can <a href="/link">pair a TV</a> or manage your{" "}
          <a href="/account">account</a>.
        </p>
      }
    >
      {props.children}
    </Show>
  );
};
