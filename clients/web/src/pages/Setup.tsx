import { createMemo, createSignal, Show, useContext } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { api } from "../api/client";
import { Notice, useAction } from "../components/ui";
import { passwordProblem } from "../format";
import { SessionContext } from "../session";

/** First run: create the admin account. Requires the one-time token from the server log. */
export default function Setup() {
  const session = useContext(SessionContext);
  const navigate = useNavigate();
  const [params] = useSearchParams<{ token: string }>();
  const status = createMemo(() => api.setupStatus());
  const [problem, setProblem] = createSignal<string | null>(null);
  const { busy, error, run } = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const pw = String(f.get("password"));
    const p = passwordProblem(pw, String(f.get("confirm")));
    setProblem(p);
    if (p) return;
    const ok = await run(() => api.setup(String(f.get("token")), String(f.get("username")), pw));
    if (ok) {
      session.reload();
      navigate("/", { replace: true });
    }
  };

  return (
    <div class="card">
      <h1>Welcome to Panda</h1>
      <Show
        when={status().needs_setup}
        fallback={
          <Notice>
            Setup is already complete. <a href="/login">Sign in</a>.
          </Notice>
        }
      >
        <p class="muted">Create the admin account. Everyone else joins later through invites.</p>
        <form class="stack" onSubmit={submit}>
          <label>
            Setup token
            <span class="hint">From the setup link in the server log.</span>
            <input name="token" value={params.token ?? ""} required autocomplete="off" />
          </label>
          <label>
            Admin username
            <input name="username" autocomplete="username" required minlength="3" maxlength="32" />
          </label>
          <label>
            Password
            <span class="hint">At least 10 characters. A phrase of a few words is ideal.</span>
            <input name="password" type="password" autocomplete="new-password" required />
          </label>
          <label>
            Confirm password
            <input name="confirm" type="password" autocomplete="new-password" required />
          </label>
          <Show when={problem() ?? error()}>
            <Notice kind="error">{problem() ?? error()}</Notice>
          </Show>
          <button class="primary" disabled={busy()}>
            {busy() ? "Creating..." : "Create admin account"}
          </button>
        </form>
      </Show>
    </div>
  );
}
