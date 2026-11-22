import { batch, createEffect, createSignal, Index, on, onCleanup, type JSX } from "solid-js";
import { TYPABLE } from "../text";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { theme, withAlpha } from "../theme";
import { Label, OPTICAL_Y } from "./Label";
import { t } from "../i18n";

const { screen, color, font, focus } = theme;

const KEY_W = 96;
const KEY_H = 84;
/** Keys sit in one joined grid; the gap is the thin line between them. */
const GAP = 2;
/** Space between sections (pages, letters, number pad, actions). */
const SECTION_GAP = 32;
/** Outer corner radius of a section. Keys are glass; the gaps between them show the sheet. */
const RADIUS = theme.radius.lg;
/** Key cells: a soft top-lit gradient. The confirm key (Done) stands out even unfocused. */
const CELL = { top: theme.glass.thin, bottom: theme.glass.thin };
const ACCENT = { top: color.accent, bottom: color.accent };
const FOCUSED = { top: color.focusFill, bottom: color.focusFill };

/** The letters section's three character rows (9 keys each), alphabetical like TV keyboards. */
const PAGES = {
  abc: ["abcdefghi", "jklmnopqr", "stuvwxyz-"],
  symbols: ["&:,!?#()_", '/+=%$€*";', "~°[]<>'^|"],
  accents: ["áéíóúüñ¿¡", "àèìòùâêîô", "ûäëïöçãõß"],
} as const;
type Page = keyof typeof PAGES;
/** The page picker on the left, like TV keyboards. */
const PAGE_ORDER: { page: Page; label: string }[] = [
  { page: "abc", label: "abc123" },
  { page: "symbols", label: "#+=" },
  { page: "accents", label: "àçñ" },
];

/**
 * A key in a row: `w` is its width in keys. `radio` draws a radio mark (page picker; true when
 * it's the current page). `accent` fills it with the accent color (Done).
 */
interface KeyDef {
  label?: string;
  icon?: string;
  w?: number;
  radio?: boolean;
  accent?: boolean;
  run: () => void;
}

const keyWidth = (w = 1) => w * KEY_W + (w - 1) * GAP;
const rowWidth = (keys: KeyDef[]) => keys.reduce((n, k) => n + keyWidth(k.w), 0) + (keys.length - 1) * GAP;
const SIDE_W = keyWidth(2);
const LETTERS_W = keyWidth(9);
const NUMPAD_W = keyWidth(3);
export const KEYBOARD_W = SIDE_W + LETTERS_W + NUMPAD_W + SIDE_W + SECTION_GAP * 3;
export const KEYBOARD_H = 4 * KEY_H + 3 * GAP;
/** The bottom sheet holding the keyboard. */
export const SHEET_H = KEYBOARD_H + 80;

/** The key whose center is closest to `x` (moving Up/Down lands on the key underneath). */
function nearest(keys: KeyDef[], x: number) {
  let at = 0;
  let best = 0;
  let bestD = Infinity;
  keys.forEach((k, i) => {
    const center = at + keyWidth(k.w) / 2;
    const d = Math.abs(center - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    at += keyWidth(k.w) + GAP;
  });
  return best;
}

/**
 * One key. Unfocused keys are the character on a dark cell; the focused key is a white tile
 * with dark text, slightly enlarged. `icon` draws an SVG from images/icons.
 */
function Key(props: { def: KeyDef; corners: [number, number, number, number]; onFocused: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const iconSize = 36;
  const w = () => keyWidth(props.def.w);
  const size = () => ((props.def.label?.length ?? 0) > 1 ? font.body : 40);
  const ink = () => (focused() ? color.focusText : props.def.accent ? color.accentText : color.text);
  const radio = () => props.def.radio !== undefined;
  const fill = () => (focused() ? FOCUSED : props.def.accent ? ACCENT : CELL);
  return (
    <View
      width={w()}
      height={KEY_H}
      // Outer corners follow the section's rounded edge; the focused key is a rounded tile.
      borderRadius={focused() ? theme.radius.sm : props.corners}
      colorTop={fill().top}
      colorBottom={fill().bottom}
      scale={focused() ? 1.08 : 1}
      zIndex={focused() ? 2 : 1}
      transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused();
      }}
      onEnter={() => (props.def.run(), true)}
    >
      {props.def.icon ? (
        <View
          src={`images/icons/${props.def.icon}.svg`}
          x={(w() - iconSize) / 2}
          y={(KEY_H - iconSize) / 2}
          width={iconSize}
          height={iconSize}
          color={ink()}
        />
      ) : radio() ? (
        <>
          {/* Radio mark: a ring, filled in for the current page. */}
          <View
            x={24}
            y={(KEY_H - 30) / 2}
            width={30}
            height={30}
            borderRadius={15}
            border={{ width: 3, color: ink() }}
            zIndex={3}
          />
          <View
            x={32}
            y={(KEY_H - 14) / 2}
            width={14}
            height={14}
            borderRadius={7}
            color={focused() ? ink() : color.accent}
            alpha={props.def.radio ? 1 : 0}
            zIndex={3}
          />
          <Text
            x={64}
            y={KEY_H / 2 + font.body * OPTICAL_Y}
            mountY={0.5}
            lineHeight={font.body}
            fontSize={font.body}
            color={ink()}
          >
            {props.def.label ?? ""}
          </Text>
        </>
      ) : (
        <Label text={props.def.label || " "} width={w()} height={KEY_H} size={size()} color={ink()} />
      )}
    </View>
  );
}

/** Rounded corners for the key at row `r`, column `i`: only the section's outer corners. */
function corners(r: number, rows: number, i: number, cols: number): [number, number, number, number] {
  const top = r === 0;
  const bottom = r === rows - 1;
  const left = i === 0;
  const right = i === cols - 1;
  return [
    top && left ? RADIUS : 0,
    top && right ? RADIUS : 0,
    bottom && right ? RADIUS : 0,
    bottom && left ? RADIUS : 0,
  ];
}

/**
 * A section of key rows. `row` is shared between sections so Left/Right keeps your row; within
 * a section, Up/Down lands on the key nearest underneath. A section with fewer rows (the page
 * picker) takes its last row for the ones it lacks.
 */
function Section(props: { rows: KeyDef[][]; width: number; row: number; onRow: (r: number) => void }) {
  const [x, setX] = createSignal(KEY_W / 2);
  return (
    <Column
      width={props.width}
      height={props.rows.length * KEY_H + (props.rows.length - 1) * GAP}
      gap={GAP}
      scroll="none"
      borderRadius={RADIUS}
      selected={Math.min(props.row, props.rows.length - 1)}
      onSelectedChanged={(i: number) => {
        props.onRow(i);
      }}
    >
      <Index each={props.rows}>
        {(keys, r) => (
          <Row
            width={rowWidth(keys())}
            height={KEY_H}
            gap={GAP}
            scroll="none"
            selected={nearest(keys(), x())}
          >
            <Index each={keys()}>
              {(k, i) => (
                <Key
                  def={k()}
                  corners={corners(r, props.rows.length, i, keys().length)}
                  onFocused={() => {
                    let at = 0;
                    for (let j = 0; j < i; j++) at += keyWidth(keys()[j].w) + GAP;
                    setX(at + keyWidth(k().w) / 2);
                  }}
                />
              )}
            </Index>
          </Row>
        )}
      </Index>
    </Column>
  );
}

/**
 * On-screen keyboard, TV style, left to right: a page picker (letters, symbols, accents), the
 * letters in a joined grid with shift and space under them, a number pad, and an action column
 * (hide keyboard, backspace, clear, Done).
 */
export function Keyboard(props: {
  x: number;
  y: number;
  ref?: (el: ElementNode) => void;
  onType: (ch: string) => void;
  onDelete: () => void;
  onClear: () => void;
  onClose: () => void;
  /** Up from the top row (e.g. to suggestions above the keyboard). */
  onTopEdge?: () => boolean | void;
}) {
  const [page, setPage] = createSignal<Page>("abc");
  const [row, setRow] = createSignal(0);
  /** Shift capitalizes the next letter only, like phone keyboards. */
  const [shift, setShift] = createSignal(false);
  const typeKey = (ch: string): KeyDef => ({ label: ch, run: () => props.onType(ch) });
  const letterKey = (ch: string): KeyDef => {
    // ß has no single-letter capital; keep it as is.
    const out = shift() && ch !== "ß" ? ch.toUpperCase() : ch;
    return {
      label: out,
      run: () => {
        props.onType(out);
        setShift(false);
      },
    };
  };
  const pages = (): KeyDef[][] =>
    PAGE_ORDER.map(p => [{ label: p.label, w: 2, radio: page() === p.page, run: () => setPage(p.page) }]);
  const letters = (): KeyDef[][] => [
    ...PAGES[page()].map(r => [...r].map(letterKey)),
    [
      { icon: shift() ? "shift-on" : "shift", w: 2, run: () => setShift(s => !s) },
      { icon: "space", w: 7, run: () => props.onType(" ") },
    ],
  ];
  const numpad = (): KeyDef[][] => [
    ["1", "2", "3"].map(typeKey),
    ["4", "5", "6"].map(typeKey),
    ["7", "8", "9"].map(typeKey),
    ["@", ".", "0"].map(typeKey),
  ];
  const actions = (): KeyDef[][] => [
    [{ icon: "keyboard-hide", w: 2, run: props.onClose }],
    [{ icon: "backspace", w: 2, run: props.onDelete }],
    [{ label: t("Clear"), w: 2, run: props.onClear }],
    [{ label: t("Done"), w: 2, accent: true, run: props.onClose }],
  ];
  return (
    <Row
      ref={props.ref}
      x={props.x}
      y={props.y}
      width={KEYBOARD_W}
      height={KEYBOARD_H}
      gap={SECTION_GAP}
      scroll="none"
      // Left from the page picker goes to the actions, Right from the actions to the picker.
      wrap
      // Start on the letters, not the page picker.
      selected={1}
      onUp={() => (row() === 0 && props.onTopEdge ? (props.onTopEdge() ?? true) : false)}
    >
      <Section rows={pages()} width={SIDE_W} row={row()} onRow={setRow} />
      <Section rows={letters()} width={LETTERS_W} row={row()} onRow={setRow} />
      <Section rows={numpad()} width={NUMPAD_W} row={row()} onRow={setRow} />
      <Section rows={actions()} width={SIDE_W} row={row()} onRow={setRow} />
    </Row>
  );
}

/** The keyboard in a sheet that slides up from the bottom of the screen while `open`. */
/** A bottom sheet that slides up while `open` (the keyboards live in one). */
function Sheet(props: { open: boolean; onBack: () => void; children: JSX.Element }) {
  return (
    <View
      y={props.open ? screen.height - SHEET_H : screen.height}
      width={screen.width}
      height={SHEET_H}
      // Solid, so content behind never shows through the keys (readability over glass).
      color={withAlpha(color.surface, 0xff)}
      alpha={props.open ? 1 : 0}
      skipFocus={!props.open}
      transition={{ y: { duration: 220, easing: "ease-out" }, alpha: { duration: 150 } }}
      zIndex={30}
      onBack={() => (props.onBack(), true)}
    >
      {/* Soft shadow above the sheet and a hairline highlight on its top edge. */}
      <View
        y={-48}
        width={screen.width}
        height={48}
        colorTop={0x00000000}
        colorBottom={0x00000080}
        zIndex={30}
      />
      <View width={screen.width} height={1} color={0xffffff1f} zIndex={31} />
      {props.children}
    </View>
  );
}

/** tvOS's own keyboard, offered by the Apple TV host (clients/appletv/app/textInput.ts). */
interface NativeTextInput {
  open(
    options: { value: string; title?: string; secure?: boolean; kind?: "text" | "email" | "url" },
    onChange: (text: string) => void,
    onDone: () => void,
  ): void;
  close(): void;
}
const nativeTextInput = (): NativeTextInput | undefined =>
  (globalThis as unknown as { pandaNativeTextInput?: NativeTextInput }).pandaNativeTextInput;

/**
 * The keyboard in a sheet that slides up from the bottom of the screen while `open`.
 *
 * On Apple TV the system keyboard takes its place: it has Siri dictation (hold the Siri button
 * and speak) and typing from an iPhone, which apps can't offer any other way. Each edit there
 * replaces the text (onClear, then onType per character, as one update); Done or Menu closes.
 */
export function KeyboardSheet(props: {
  open: boolean;
  ref?: (el: ElementNode) => void;
  onType: (ch: string) => void;
  onDelete: () => void;
  onClear: () => void;
  onClose: () => void;
  onTopEdge?: () => boolean | void;
  /** The text being edited (the system keyboard starts from it). */
  value?: string;
  /** Prompt for the system keyboard. */
  title?: string;
  secure?: boolean;
  kind?: "text" | "email" | "url";
}) {
  const native = nativeTextInput();
  if (native) {
    let showing = false;
    createEffect(
      on(
        () => props.open,
        open => {
          if (open && !showing) {
            showing = true;
            native.open(
              { value: props.value ?? "", title: props.title, secure: props.secure, kind: props.kind },
              text =>
                batch(() => {
                  props.onClear();
                  for (const ch of text) props.onType(ch);
                }),
              () => {
                showing = false;
                // After the system keyboard has gone (a page may open the next field from here).
                setTimeout(() => props.onClose(), 50);
              },
            );
          } else if (!open && showing) {
            native.close();
          }
        },
      ),
    );
    onCleanup(() => showing && native.close());
    // Pages focus the keyboard when they open it: an empty stand-in takes that focus.
    return <View ref={props.ref} width={1} height={1} alpha={0} onBack={() => (props.onClose(), true)} />;
  }
  return (
    <Sheet open={props.open} onBack={props.onClose}>
      <Keyboard
        x={(screen.width - KEYBOARD_W) / 2}
        y={(SHEET_H - KEYBOARD_H) / 2}
        ref={props.ref}
        onType={props.onType}
        onDelete={props.onDelete}
        onClear={props.onClear}
        onClose={props.onClose}
        onTopEdge={props.onTopEdge}
      />
    </Sheet>
  );
}

/** Number pad keys are wider than the keyboard's: it's the only section, so it can breathe. */
const PAD_KEY = 1.6;
const PAD_W = keyWidth(PAD_KEY) * 3 + GAP * 2;

/**
 * Number pad in a sheet (PINs): 1-9, then backspace, 0 and Done, styled like the keyboard.
 */
export function NumberPadSheet(props: {
  open: boolean;
  ref?: (el: ElementNode) => void;
  onDigit: (d: string) => void;
  onDelete: () => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const [row, setRow] = createSignal(0);
  const digit = (d: string): KeyDef => ({ label: d, w: PAD_KEY, run: () => props.onDigit(d) });
  const rows = (): KeyDef[][] => [
    ["1", "2", "3"].map(digit),
    ["4", "5", "6"].map(digit),
    ["7", "8", "9"].map(digit),
    [
      { icon: "backspace", w: PAD_KEY, run: props.onDelete },
      digit("0"),
      { label: t("Done"), w: PAD_KEY, accent: true, run: props.onDone },
    ],
  ];
  return (
    <Sheet open={props.open} onBack={props.onBack}>
      <View
        ref={props.ref}
        x={(screen.width - PAD_W) / 2}
        y={(SHEET_H - KEYBOARD_H) / 2}
        width={PAD_W}
        height={KEYBOARD_H}
        forwardFocus={0}
      >
        <Section rows={rows()} width={PAD_W} row={row()} onRow={setRow} />
      </View>
    </Sheet>
  );
}

/**
 * A real keyboard (browser, or one plugged into the TV) types into this page. The capture
 * phase gets keys before the remote mapping, where letters are shortcuts (b = Back, p = Play,
 * m = Menu). Backspace deletes while there's text and is Back when it's empty.
 */
export function useTypedInput(opts: {
  /** False while an overlay owns the keys. */
  enabled: () => boolean;
  hasText: () => boolean;
  onType: (ch: string) => void;
  onDelete: () => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !opts.enabled()) return;
    if (e.key === "Backspace" && opts.hasText()) opts.onDelete();
    else if (e.key.length === 1 && TYPABLE.test(e.key)) opts.onType(e.key);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
}
