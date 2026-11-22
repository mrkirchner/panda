import { createSignal, Show, type ParentComponent } from "solid-js";
import type { JSX } from "@solidjs/web";
import { errorMessage } from "../api/client";

export const Card: ParentComponent<{ title?: string }> = (props) => (
  <section class="card">
    <Show when={props.title}>
      <h2>{props.title}</h2>
    </Show>
    {props.children}
  </section>
);

export function Notice(props: { kind?: "error" | "ok"; children: JSX.Element }) {
  return <div class={["notice", props.kind]}>{props.children}</div>;
}

/** Run an async action with busy + error state, for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** A button that asks for confirmation before destructive actions. */
export function ConfirmButton(props: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      class="danger"
      disabled={props.disabled}
      onClick={() => {
        if (window.confirm(props.confirm)) props.onConfirm();
      }}
    >
      {props.label}
    </button>
  );
}

export function ErrorView(props: { error: unknown; retry?: () => void }) {
  return (
    <Notice kind="error">
      {errorMessage(props.error)}{" "}
      <Show when={props.retry}>
        <button class="link" onClick={() => props.retry?.()}>
          Retry
        </button>
      </Show>
    </Notice>
  );
}
