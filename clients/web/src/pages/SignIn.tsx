import { createMemo, createSignal, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { api } from "../api/client";
import { Notice, useAction } from "../components/ui";
import { passwordProblem } from "../format";

/** A sign-in link for a profile: the person chooses their password (the email came with it). */
export default function SignIn() {
  const params = useParams<{ code: string }>();
  const check = createMemo(() => api.signInLinkCheck(params.code ?? ""));
  const [problem, setProblem] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const { busy, error, run } = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const pw = String(f.get("password"));
    const p = passwordProblem(pw, String(f.get("confirm")));
    setProblem(p);
    if (p) return;
    if (await run(() => api.signInLinkUse(params.code ?? "", pw))) setDone(true);
  };

  return (
    <div class="card">
      <Show
        when={check().valid}
        fallback={
          <>
            <h1>Set up your Panda sign-in</h1>
            <Notice kind="error">This link is invalid, already used, or expired. Ask for a new one.</Notice>
          </>
        }
      >
        <h1>Hi {check().name}, choose your password</h1>
        <Show
          when={!done()}
          fallback={
            <Notice kind="ok">
              All set. Sign in on any TV with {check().email} and your new password: on the TV, choose Sign in
              and enter them.
            </Notice>
          }
        >
          <p class="muted">You'll sign in with {check().email}.</p>
          <form class="stack" onSubmit={submit}>
            <input type="email" name="email" autocomplete="username" value={check().email ?? ""} hidden />
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
              {busy() ? "Saving..." : "Save password"}
            </button>
          </form>
        </Show>
      </Show>
    </div>
  );
}
