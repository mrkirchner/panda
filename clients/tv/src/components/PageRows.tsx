import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { useLocation } from "@solidjs/router";
import { holdAnimations, instantly, PositionsContext, positionsFor } from "../focusMemory";
import { View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { type ElementNode } from "@solidtv/solid";
import { theme } from "../theme";

const { screen } = theme;

/** Height of a page's header area (hero or title block). Rows start below it. */
export const HEADER_H = 880;
/** How long Back waits for the row it left from to load. */
const RESTORE_WAIT_MS = 4000;

/** Focused rows scroll to this y, clear of the profile pill. */
export const ROW_TOP = 140;

/**
 * The scrolling layout shared by Home, show pages and future browse pages: a header area
 * (index 0) followed by card rows. Each focused row scrolls to ROW_TOP; Up from the first
 * row returns to the header.
 */
export function PageRows(props: {
  onHeaderFocused?: (focused: boolean) => void;
  /** Up from the header (Home: its top bar). Unset: Up stops there. */
  onTopUp?: () => boolean;
  children: JSX.Element;
}) {
  let column: ElementNode | undefined;
  const [onHeader, setOnHeader] = createSignal(true);
  // Back to this page: focus the row (and in it, the card: CardRow) it was left from. Rows
  // that load later are waited for, unless you've moved on by then.
  const location = useLocation();
  const positions = positionsFor(location.pathname + location.search);
  const saved = positions.get<{ index: number; key?: string }>("rows");
  /** Where the row is now: found by its key (CardRow's title), else by its old place. */
  const target = () => {
    const kids = column?.children ?? [];
    const byKey = saved?.key ? kids.findIndex(c => (c as { rowKey?: string }).rowKey === saved.key) : -1;
    return byKey >= 0 ? byKey : saved?.key ? -1 : (saved?.index ?? 0);
  };
  let restoring = (saved?.index ?? 0) > 0;
  // Hidden, animations off, until the row (and its card: CardRow) are back in place.
  const endRow = restoring ? positions.begin() : undefined;
  if (restoring) {
    const endHold = holdAnimations();
    createEffect(() => {
      if (!positions.busy()) endHold();
    });
    onCleanup(endHold);
    // The header isn't where you are: the backdrop starts dimmed.
    props.onHeaderFocused?.(false);
  }
  if (restoring) {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryRestore = () => {
      if (!restoring || !column) return;
      const at = target();
      const row = at >= 0 ? (column.children[at] as ElementNode | undefined) : undefined;
      if (row && !row.skipFocus) {
        restoring = false;
        // Scrolls there and focuses it (setting `selected` alone doesn't scroll).
        const col = column as unknown as { scrollToIndex: (i: number) => void };
        instantly(() => col.scrollToIndex(at));
        setOnHeader(false);
        props.onHeaderFocused?.(false);
        // The row's card is restored on its focus (CardRow): a frame for that to begin.
        setTimeout(() => endRow?.(), 50);
        return;
      }
      if (Date.now() - started < RESTORE_WAIT_MS) timer = setTimeout(tryRestore, 50);
      else {
        restoring = false;
        endRow?.();
      }
    };
    onMount(() => (timer = setTimeout(tryRestore, 0)));
    onCleanup(() => clearTimeout(timer));
  }
  return (
    <PositionsContext.Provider value={positions}>
      <Column
        ref={column}
        // Back to this page: shown once everything is back where it was.
        alpha={positions.busy() ? 0 : 1}
        // Up from the header goes to the page's top bar if it has one.
        onUp={() => ((column?.selected ?? 0) === 0 ? (props.onTopUp?.() ?? true) : false)}
        y={ROW_TOP}
        offset={ROW_TOP}
        width={screen.width}
        height={screen.height}
        gap={10}
        scroll="always"
        autofocus
        // Block body on purpose: a truthy return would stop the Column's own scrolling.
        onSelectedChanged={(i: number) => {
          // Moved down yourself before the rows came: don't pull focus back.
          if (i > 0 && restoring) {
            restoring = false;
            endRow?.();
          }
          const key = (column?.children[i] as { rowKey?: string } | undefined)?.rowKey;
          positions.set("rows", { index: i, key });
          setOnHeader(i === 0);
          props.onHeaderFocused?.(i === 0);
        }}
      >
        {props.children}
      </Column>
      {/* Fades out whatever scrolled above the focused row, so it never shows behind the
        profile pill. Hidden on the header so the backdrop stays clear. zIndex: see CLAUDE.md. */}
      <View width={screen.width} height={ROW_TOP - 10} alpha={onHeader() ? 0 : 1} zIndex={5} skipFocus>
        <View width={screen.width} height={ROW_TOP - 50} color={theme.color.background} zIndex={5} />
        <View
          y={ROW_TOP - 50}
          width={screen.width}
          height={40}
          colorTop={theme.color.background}
          colorBottom={theme.color.background & 0xffffff00}
          zIndex={5}
        />
      </View>
    </PositionsContext.Provider>
  );
}

/**
 * The first item of a PageRows: full-height header content (drawn from y=0 of the screen)
 * that fades out while the rows below are focused.
 */
export function HeaderArea(props: { visible: boolean; children: JSX.Element }) {
  return (
    <View width={screen.width} height={HEADER_H - ROW_TOP} forwardFocus={0}>
      <View
        y={-ROW_TOP}
        width={screen.width}
        height={HEADER_H}
        forwardFocus={0}
        alpha={props.visible ? 1 : 0}
      >
        {props.children}
      </View>
    </View>
  );
}
