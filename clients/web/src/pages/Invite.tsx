import { createMemo, createSignal, Show, useContext } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "../api/client";
import { Notice, useAction } from "../components/ui";
import { passwordProblem } from "../format";
import { SessionContext } from "../session";

/** Accept an invite link: pick a username and password. */
export default function Invite() {
  const session = useContext(SessionContext);
  const navigate = useNavigate();
  const params = useParams<{ code: string }>();
  const check = createMemo(() => api.inviteCheck(params.code ?? ""));
  const [problem, setProblem] = createSignal<string | null>(null);
  const { busy, error, run } = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const pw = String(f.get("password"));
    const p = passwordProblem(pw, String(f.get("confirm")));
    setProblem(p);
    if (p) return;
    const ok = await run(() => api.inviteAccept(params.code ?? "", String(f.get("username")), pw));
    if (ok) {
      session.reload();
      navigate("/link", { replace: true });
    }
  };

  return (
    <div class="card">
      <h1>You're invited to Panda</h1>
      <Show
        when={check().valid}
        fallback={
          <Notice kind="error">
            This invite link is invalid, already used, or expired. Ask for a new one.
          </Notice>
        }
      >
        <form class="stack" onSubmit={submit}>
          <label>
            Username
            <span class="hint">3-32 letters, digits, ".", "_" or "-".</span>
            <input name="username" autocomplete="username" required minlength="3" maxlength="32" />
          </label>
          <label>
            Password
            <span class="hint">At least 10 characters.</span>
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
            {busy() ? "Creating account..." : "Create my account"}
          </button>
        </form>
      </Show>
    </div>
  );
}
