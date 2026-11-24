import { createMemo, Show, useContext } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { api } from "../api/client";
import { Notice, useAction } from "../components/ui";
import { SessionContext } from "../session";

/**
 * Sign-in form. Rendered for the /login route *and* in place of any protected page when
 * signed out, so after signing in you land exactly where you were going.
 */
export default function Login() {
  const session = useContext(SessionContext);
  const navigate = useNavigate();
  const location = useLocation();
  const status = createMemo(() => api.setupStatus());
  const { busy, error, run } = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const ok = await run(() => api.login(String(f.get("username")), String(f.get("password"))));
    if (ok) {
      session.reload();
      if (location.pathname === "/login") navigate("/", { replace: true });
    }
  };

  return (
    <div class="card">
      <h1>Sign in to Panda</h1>
      <Show
        when={!status().needs_setup}
        fallback={
          <div class="stack">
            <Notice>
              This server isn't set up yet. Create the admin account with the one-time setup link.
            </Notice>
            <p>
              Find it in the terminal running the Panda server (search for{" "}
              <strong>"Create the admin account"</strong>), or run this in the Panda folder:
            </p>
            <pre class="secret mono">cat data/setup-token</pre>
            <p class="muted">
              Then paste the token on the <a href="/setup">setup page</a>.
            </p>
          </div>
        }
      >
        <form class="stack" onSubmit={submit}>
          <label>
            Username
            <input name="username" autocomplete="username" required autofocus />
          </label>
          <label>
            Password
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <Show when={error()}>
            <Notice kind="error">{error()}</Notice>
          </Show>
          <button class="primary" disabled={busy()}>
            {busy() ? "Signing in..." : "Sign in"}
          </button>
          <p class="muted">No account? Ask the server owner for an invite link.</p>
        </form>
      </Show>
    </div>
  );
}
