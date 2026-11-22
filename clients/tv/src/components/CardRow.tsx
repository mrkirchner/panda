import { perf } from "#devices/tier";
import { createEffect, createSignal, For, on } from "solid-js";
import { hasFocus, Text, View, type ElementNode } from "@solidtv/solid";
import { VirtualRow } from "@solidtv/solid/primitives";
import { displayText } from "../format";
import { instantly, usePositions } from "../focusMemory";
import { theme } from "../theme";
import {
  CAPTION_H,
  Card,
  EXPAND,
  EXPAND_CAPTION_H,
  EXPAND_EXTRA,
  ExpandCard,
  RANK_W,
  type CardProps,
  type CardVariant,
} from "./Cards";
import { FeatureCard, GENRE, TALL } from "./FeatureCards";

const { screen, font, color } = theme;
/** Standard poster: the same size as a closed `expand` card, so poster rows line up with them. */
export const POSTER = { width: EXPAND.width, height: EXPAND.height };
/** Continue Watching: a compact 16:9 card with title and progress underneath. */
export const WIDE = { width: 400, height: 225 };
export const LANDSCAPE = { width: 560, height: 315 };
export const LARGE = { width: 280, height: 420 };
/** Layout size of each card (an `expand` card is laid out closed; it draws wider when open). */
const SIZES: Record<CardVariant, { width: number; height: number }> = {
  poster: POSTER,
  wide: WIDE,
  landscape: LANDSCAPE,
  large: LARGE,
  expand: { width: EXPAND.width, height: EXPAND.height },
  tall: TALL,
  genre: GENRE,
};
/** Heading band above the cards: room for the title plus a focused card's growth (8%, half of
 * it upward) and ring, with a clear gap left under the title. */
const HEADING = 92;
const GAP = theme.space.item;
/** Clip margin around a row's cards: covers the focus grow (8%) plus the ring, but not the
 * previous card, which ends GAP to the left of the first. */
const EDGE = theme.tabContentTop;

/** Artwork plus caption height of one card. */
const cardHeight = (v: CardVariant) =>
  SIZES[v].height + (v === "wide" ? CAPTION_H : v === "expand" ? EXPAND_CAPTION_H : 0);

/** Height a row occupies in a Column. Untitled rows (under a page's tabs) keep only the
 * room a focused card grows into. */
export const rowHeight = (v: CardVariant = "poster", titled = true) =>
  (titled ? HEADING : EDGE) + cardHeight(v) + 40;

/**
 * A titled, virtualized row of cards: only visible cards (plus a small buffer) exist as nodes,
 * so a row of 500 posters costs the same as a row of 10.
 *
 * `expand` rows: the focused card opens to the right and every later card slides over by the
 * same amount (an x offset inside each card), so the row's own layout and scrolling never
 * change size.
 */
export function CardRow<T>(props: {
  title: string;
  items: T[];
  variant?: CardVariant;
  card: (item: T) => CardProps;
  /** Where the heading and first card start (default: the screen gutter). */
  left?: number;
  /** A top ten: each card's `rank` drawn big to its left, with room left for it. */
  ranked?: boolean;
}) {
  const variant = () => props.variant ?? "poster";
  const size = () => SIZES[variant()];
  // Back to the page: the card it was left from, found by its title (rows are told apart by
  // theirs): items can arrive or move in front of it after mounting (My List's requests), so
  // it's looked up again as they change, until you move yourself.
  const positions = usePositions();
  const slot = `row:${props.title}`;
  const saved = positions?.get<{ index: number; key: string }>(slot);
  const indexOf = (key: string) => props.items.findIndex(it => props.card(it).title === key);
  // The page stays hidden until this row is back on its card (when it's the focused row).
  let endRestore: (() => void) | undefined;
  /** Until you move yourself, the saved card is followed as items arrive (My List's requests
   * are added in front of it after the row first shows). */
  let restoring = !!saved;
  let restoredTo = -1;
  /** The restore's own steps (not you moving). */
  let stepping = false;
  /** Bring the saved card in the way moving there would (the row's own scrollToIndex: setting
   * `selected` alone leaves a long row's window misaligned). Done once the row has focus. */
  const restore = () => {
    if (!restoring || !saved || !rowRef || !hasFocus(rowRef)) return;
    const k = indexOf(saved.key);
    const i = k >= 0 ? k : Math.min(saved.index, props.items.length - 1);
    if (i < 0 || i === restoredTo) {
      endRestore?.();
      return;
    }
    // From where it is now, step there with Right/Left presses (instantly): it ends exactly
    // as moving there yourself would (the row's scrollToIndex leaves a long row's scrolling off
    // near its end, so the next press jumps).
    const row = rowRef as unknown as { onRight?: () => boolean; onLeft?: () => boolean };
    const from = restoredTo < 0 ? 0 : restoredTo;
    restoredTo = i;
    let steps = i - from;
    endRestore ??= positions?.begin();
    const step = () => {
      if (steps === 0 || !restoring) {
        endRestore?.();
        return;
      }
      stepping = true;
      instantly(() => (steps > 0 ? row.onRight : row.onLeft)?.call(rowRef));
      stepping = false;
      steps += steps > 0 ? -1 : 1;
      // The row rebuilds its window after each step (a microtask): the next one after that.
      setTimeout(step, 0);
    };
    step();
  };
  // Items can arrive after the row got focus.
  if (saved)
    createEffect(
      on(
        () => props.items,
        () => setTimeout(restore, 0),
      ),
    );
  // Stop following once you've moved (or after a few seconds).
  if (saved) setTimeout(() => (restoring = false), 5000);
  const left = () => props.left ?? screen.gutter;
  const top = () => (props.title ? HEADING : EDGE);
  /** Ranked rows leave room for each card's number before it. */
  const rankW = () => (props.ranked ? RANK_W : 0);
  const visible = () => Math.ceil((screen.width - left()) / (size().width + GAP + rankW())) + 1;
  /** Index of the focused card in an `expand` row, or -1 while the row isn't focused. */
  const [open, setOpen] = createSignal(-1);
  let rowRef: ElementNode | undefined;
  /**
   * A card opened by hovering it (pointer mode) can grow past the screen's right edge: scroll
   * the row just enough that the whole open card shows.
   */
  const [nudge, setNudge] = createSignal(0);
  const revealOpen = (i: number) => {
    const card = rowRef?.children.find(c => (c as { item?: unknown }).item === props.items[i]) as
      ElementNode | undefined;
    if (!card) return;
    // Where it would end without a nudge, against the screen's right gutter.
    const right = (card.lng.absX ?? 0) + nudge() + EXPAND.open;
    setNudge(Math.max(0, right - (screen.width - screen.gutter)));
  };
  const shiftFor = (item: T) => {
    const o = open();
    return o >= 0 && props.items.indexOf(item) > o ? EXPAND_EXTRA : 0;
  };
  return (
    <View
      // PageRows finds this row again by it on Back (rows above can arrive later).
      rowKey={slot}
      width={screen.width}
      height={rowHeight(variant(), !!props.title)}
      forwardFocus={1}
      onFocusChanged={(f: boolean) => {
        if (!f) setOpen(-1);
        // Back to the page: the first time it's focused, its saved card (begun at once, so the
        // page stays hidden until it's there).
        else {
          restore();
          setTimeout(restore, 0);
        }
      }}
    >
      <Text x={left()} fontSize={font.heading} color={color.text}>
        {displayText(props.title)}
      </Text>
      {/* Clipped just outside the cards: room for the focused card's grow and ring, but the
          card that scrolled off to the left no longer peeks in at the screen edge. */}
      <View
        x={left() - EDGE}
        y={top() - EDGE}
        width={screen.width - left() + EDGE}
        height={cardHeight(variant()) + EDGE * 2}
        clipping
        forwardFocus={0}
      >
        {/* Nudged left just enough to fit a hover-opened card (pointer mode); the row's own
            scrolling is untouched. */}
        <View
          x={-nudge()}
          width={screen.width - left() + EDGE * 2}
          height={cardHeight(variant()) + EDGE * 2}
          forwardFocus={0}
          transition={{ x: { duration: theme.focus.expandDuration, easing: "ease-out" } }}
        >
          <VirtualRow
            ref={(el: ElementNode) => (rowRef = el)}
            x={EDGE + rankW()}
            y={EDGE}
            width={screen.width - left() - rankW()}
            height={cardHeight(variant())}
            gap={GAP + rankW()}
            // Block body on purpose: a truthy return would stop the row's own scrolling.
            // `i` is the card's place in the row's window, not in the list: the card says which
            // item it is.
            onSelectedChanged={(_i: number, _row: ElementNode, active?: ElementNode) => {
              const item = (active as { item?: T } | undefined)?.item;
              if (item === undefined) return;
              // A row no longer than the screen doesn't scroll: slide it just enough that the
              // focused card (with its ring) shows whole, and back when you go left again.
              if (props.items.length <= visible() && variant() !== "expand" && active) {
                // Where its right edge sits unnudged, plus room for the focus grow and ring.
                const right =
                  left() + rankW() + (active.x ?? 0) + size().width * (1 + (theme.focus.scale - 1) / 2) + 12;
                setNudge(Math.max(0, right - (screen.width - screen.gutter)));
              }
              // By title: some pages build their items afresh each time (not the same objects).
              const key = props.card(item).title;
              if (!stepping && restoring && restoredTo >= 0 && key !== saved?.key) restoring = false;
              positions?.set(slot, { index: Math.max(0, indexOf(key)), key });
            }}
            each={props.items}
            // Same count for `expand` rows: the cards after an open one are drawn further right, so
            // the one sliding in at the screen edge must already exist (and its artwork preloaded:
            // see boundsMargin in devices/common).
            displaySize={visible()}
            bufferSize={perf.listBuffer}
            uniformSize
            scroll="always"
          >
            {item =>
              variant() === "expand" ? (
                <ExpandCard
                  {...props.card(item())}
                  item={item()}
                  width={EXPAND.width}
                  height={EXPAND.height}
                  shiftX={shiftFor(item())}
                  onFocused={() => props.card(item()).onFocused?.()}
                  // Later cards slide over by the open card's growth.
                  onOpenChanged={o => {
                    const i = props.items.indexOf(item());
                    if (o) {
                      setOpen(i);
                      revealOpen(i);
                    } else if (open() === i) {
                      setOpen(-1);
                      setNudge(0);
                    }
                  }}
                />
              ) : variant() === "tall" || variant() === "genre" ? (
                <FeatureCard
                  {...props.card(item())}
                  item={item()}
                  width={size().width}
                  height={size().height}
                  variant={variant() as "tall" | "genre"}
                />
              ) : (
                <Card
                  {...props.card(item())}
                  item={item()}
                  width={size().width}
                  height={size().height}
                  variant={variant()}
                />
              )
            }
          </VirtualRow>
        </View>
      </View>
    </View>
  );
}

/**
 * A placeholder for a row still on its way: a heading bar and a few neutral cards of the
 * row's size, so the page keeps its shape and nothing jumps when the real row lands. Not
 * focusable.
 */
export function GhostRow(props: { variant?: CardVariant; left?: number }) {
  const v = () => props.variant ?? "poster";
  const left = () => props.left ?? screen.gutter;
  const count = () => Math.ceil((screen.width - left()) / (SIZES[v()].width + GAP));
  return (
    <View width={screen.width} height={rowHeight(v())} skipFocus>
      <View
        x={left()}
        y={10}
        width={280}
        height={30}
        borderRadius={theme.radius.sm}
        color={theme.glass.thin}
      />
      <For each={Array.from({ length: count() }, (_, i) => i)}>
        {i => (
          <View
            x={left() + i * (SIZES[v()].width + GAP)}
            y={HEADING}
            width={SIZES[v()].width}
            height={SIZES[v()].height}
            borderRadius={theme.radius.md}
            color={theme.glass.thin}
          />
        )}
      </For>
    </View>
  );
}
