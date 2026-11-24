// Dialogs, menus and toasts, asked for from anywhere (`pick`, `ask`, `confirmAction`, `toast`) and
// drawn by <Overlays/> in the shell. A menu opens under the control that asked for it on wide
// screens, and as a centred list on phones.
import { For, Show, createRoot, createSignal, onSettled } from "solid-js";
import { t } from "@tv/i18n";
import { Icon } from "./icons";

export interface Choice {
  label: string;
  selected?: boolean;
  /** Shown before the option (a section heading). */
  heading?: string;
  danger?: boolean;
}

type Overlay =
  | { kind: "many"; title: string; options: string[]; ok: string; resolve: (picked: number[] | null) => void }
  | { kind: "pick"; title?: string; options: Choice[]; anchor?: DOMRect; resolve: (i: number) => void }
  | {
      kind: "ask";
      title: string;
      message?: string;
      input?: { type: "text" | "password" | "pin" | "email"; placeholder?: string; value?: string };
      ok: string;
      danger?: boolean;
      resolve: (v: string | null) => void;
    };

const store = createRoot(() => {
  const [overlay, setOverlay] = createSignal<Overlay | null>(null);
  const [toastText, setToastText] = createSignal("");
  return { overlay, setOverlay, toastText, setToastText };
});

/** Choose one of `options`: its index, or -1 when dismissed. `anchor`: the control it drops from. */
export function pick(title: string | undefined, options: Choice[], anchor?: Element | null): Promise<number> {
  closeOverlay();
  return new Promise((resolve) =>
    store.setOverlay({
      kind: "pick",
      title,
      options,
      anchor: anchor?.getBoundingClientRect(),
      resolve: (i) => {
        store.setOverlay(null);
        resolve(i);
      },
    }),
  );
}

/** Choose any of `options` (all to start with): the indices chosen, or null when cancelled. */
export function pickMany(title: string, options: string[], ok: string): Promise<number[] | null> {
  closeOverlay();
  return new Promise((resolve) =>
    store.setOverlay({
      kind: "many",
      title,
      options,
      ok,
      resolve: (v) => {
        store.setOverlay(null);
        resolve(v);
      },
    }),
  );
}

/** A question with an optional field: what was typed (or "" without a field), null if cancelled. */
export function ask(
  title: string,
  opts: {
    message?: string;
    input?: Extract<Overlay, { kind: "ask" }>["input"];
    ok?: string;
    danger?: boolean;
  } = {},
): Promise<string | null> {
  closeOverlay();
  return new Promise((resolve) =>
    store.setOverlay({
      kind: "ask",
      title,
      message: opts.message,
      input: opts.input,
      ok: opts.ok ?? t("OK"),
      danger: opts.danger,
      resolve: (v) => {
        store.setOverlay(null);
        resolve(v);
      },
    }),
  );
}

/** Yes or no. */
export const confirmAction = async (title: string, message: string, ok: string, danger = false) =>
  (await ask(title, { message, ok, danger })) !== null;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message at the bottom of the screen. */
export function toast(text: string, ms = 3500) {
  store.setToastText(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.setToastText(""), ms);
}

function PickMenu(props: { o: Extract<Overlay, { kind: "pick" }> }) {
  let first: HTMLButtonElement | undefined;
  onSettled(() => first?.focus());
  const wide = () => !!props.o.anchor && window.innerWidth >= 600;
  const style = () => {
    const a = props.o.anchor!;
    const left = Math.min(Math.max(8, a.left), window.innerWidth - 268);
    const below = a.bottom + 6;
    return window.innerHeight - below > 280
      ? { left: `${left}px`, top: `${below + window.scrollY}px` }
      : {
          left: `${left}px`,
          top: `${Math.max(8, a.top - 6 - Math.min(420, props.o.options.length * 42 + 20)) + window.scrollY}px`,
        };
  };
  const list = () => (
    <For each={props.o.options}>
      {(c, i) => (
        <>
          <Show when={c.heading}>
            <div class="menu-label">{c.heading}</div>
          </Show>
          <button
            class={["menu-item", { selected: !!c.selected, error: !!c.danger }]}
            ref={(el) => {
              if (i() === 0) first = el;
            }}
            onClick={() => props.o.resolve(i())}
          >
            <span>{c.label}</span>
            <Show when={c.selected}>
              <Icon name="check" size={18} class="check" />
            </Show>
          </button>
        </>
      )}
    </For>
  );
  return (
    <Show
      when={wide()}
      fallback={
        <div class="backdrop-dim" onClick={(e) => e.target === e.currentTarget && props.o.resolve(-1)}>
          <div class="dialog sheet-list" role="dialog" aria-label={props.o.title}>
            <Show when={props.o.title}>
              <h2>{props.o.title}</h2>
            </Show>
            {list()}
          </div>
        </div>
      }
    >
      <div
        class="menu-catcher"
        style={{ position: "fixed", inset: "0", "z-index": "299" }}
        onClick={() => props.o.resolve(-1)}
      />
      <div class="menu" role="menu" aria-label={props.o.title} style={style()}>
        {list()}
      </div>
    </Show>
  );
}

function AskDialog(props: { o: Extract<Overlay, { kind: "ask" }> }) {
  const [value, setValue] = createSignal(() => props.o.input?.value ?? "");
  let field: HTMLInputElement | undefined;
  let okBtn: HTMLButtonElement | undefined;
  onSettled(() => (field ?? okBtn)?.focus());
  const submit = (e?: Event) => {
    e?.preventDefault();
    props.o.resolve(props.o.input ? value() : "");
  };
  return (
    <div class="backdrop-dim" onClick={(e) => e.target === e.currentTarget && props.o.resolve(null)}>
      <form class="dialog" role="dialog" aria-label={props.o.title} onSubmit={submit}>
        <h2>{props.o.title}</h2>
        <Show when={props.o.message}>
          <p class="lede">{props.o.message}</p>
        </Show>
        <Show when={props.o.input}>
          {(input) => (
            <input
              ref={(el) => (field = el)}
              class={["input", { "pin-input": input().type === "pin" }]}
              type={input().type === "pin" ? "password" : input().type}
              inputmode={input().type === "pin" ? "numeric" : undefined}
              maxlength={input().type === "pin" ? 4 : undefined}
              autocomplete="off"
              placeholder={input().placeholder}
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          )}
        </Show>
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => props.o.resolve(null)}>
            {t("Cancel")}
          </button>
          <button
            ref={(el) => (okBtn = el)}
            type="submit"
            class={["btn", props.o.danger ? "danger" : "primary"]}
          >
            {props.o.ok}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The TV's season picker: All, or any of them. */
function ManyDialog(props: { o: Extract<Overlay, { kind: "many" }> }) {
  const [chosen, setChosen] = createSignal<Set<number>>(new Set(props.o.options.map((_, i) => i)));
  const all = () => chosen().size === props.o.options.length;
  const flip = (i: number) =>
    setChosen((c) => {
      const n = new Set(c);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <div class="backdrop-dim" onClick={(e) => e.target === e.currentTarget && props.o.resolve(null)}>
      <div class="dialog" role="dialog" aria-label={props.o.title}>
        <h2>{props.o.title}</h2>
        <div class="chips">
          <button
            class={["chip", { on: all() }]}
            onClick={() => setChosen(all() ? new Set<number>() : new Set(props.o.options.map((_, i) => i)))}
          >
            {t("All")}
          </button>
          <For each={props.o.options}>
            {(label, i) => (
              <button
                class={["chip", { on: chosen().has(i()) }]}
                aria-pressed={chosen().has(i()) ? "true" : "false"}
                onClick={() => {
                  flip(i());
                }}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <div class="dialog-actions">
          <button class="btn" onClick={() => props.o.resolve(null)}>
            {t("Cancel")}
          </button>
          <button
            class="btn primary"
            disabled={chosen().size === 0}
            onClick={() => props.o.resolve([...chosen()].sort((a, b) => a - b))}
          >
            {props.o.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Whether a dialog or menu is open (pages leave keys alone then). */
export const overlayOpen = () => store.overlay() !== null;

/** Escape closes what's open. */
export function closeOverlay(): boolean {
  const o = store.overlay();
  if (!o) return false;
  if (o.kind === "pick") o.resolve(-1);
  else o.resolve(null);
  return true;
}

export function Overlays() {
  return (
    <>
      <Show when={store.overlay()?.kind === "pick" ? store.overlay() : null} keyed>
        {(o) => <PickMenu o={o as Extract<Overlay, { kind: "pick" }>} />}
      </Show>
      <Show when={store.overlay()?.kind === "many" ? store.overlay() : null} keyed>
        {(o) => <ManyDialog o={o as Extract<Overlay, { kind: "many" }>} />}
      </Show>
      <Show when={store.overlay()?.kind === "ask" ? store.overlay() : null} keyed>
        {(o) => <AskDialog o={o as Extract<Overlay, { kind: "ask" }>} />}
      </Show>
      <Show when={store.toastText()}>
        <div class="toast" role="status">
          {store.toastText()}
        </div>
      </Show>
    </>
  );
}
