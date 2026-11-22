import { createSignal, onCleanup, Show } from "solid-js";
import { View } from "@solidtv/solid";
import {
  hovered,
  pageScroll,
  rowScroll,
  rowScrollState,
  SCROLL_BAND,
  scrollableDirections,
  type RowScroll,
} from "../pointer";
import { theme } from "../theme";

const { screen, color } = theme;
/** Slim, so it barely overlaps the content above it; content under it counts as off screen. */
const BAND_H = SCROLL_BAND;
/** The top band starts under the top bar (avatar, search and tabs stay clickable). */
const TOP_Y = 96;
const ICON = 40;
/** How often to check whether there's anything to scroll to. */
const CHECK_MS = 250;

/**
 * Pointer mode (Magic Remote): the cursor only reaches what's on screen, so the edges scroll.
 * A wide fade along the bottom pages down (to the next section, or a screenful in a long list)
 * and the same fade under the top bar pages up, each shown only while there's something that way. Faint until pointed at.
 * They never take focus (`onPointerSelect`), so focus moves as with the remote's arrows.
 */
export function ScrollArrows() {
  const [can, setCan] = createSignal({ up: false, down: false });
  const [row, setRow] = createSignal<RowScroll | undefined>();
  const nodes = new Set<unknown>();
  const check = () => {
    setCan(scrollableDirections(window.APP, nodes));
    // Keep the side bands where they are while one is pointed at (hover would otherwise move
    // focus off the row under them).
    if (![...nodes].includes(hovered())) setRow(rowScrollState());
  };
  check();
  const timer = setInterval(check, CHECK_MS);
  onCleanup(() => clearInterval(timer));
  return (
    <>
      <Show when={can().up}>
        <Band dir="up" y={TOP_Y} nodes={nodes} onPress={() => setTimeout(check, 400)} />
      </Show>
      <Show when={row()?.left}>
        <SideBand dir="left" row={row()!} nodes={nodes} onPress={() => setTimeout(check, 400)} />
      </Show>
      <Show when={row()?.right}>
        <SideBand dir="right" row={row()!} nodes={nodes} onPress={() => setTimeout(check, 400)} />
      </Show>
      <Show when={can().down}>
        <Band dir="down" y={screen.height - BAND_H} nodes={nodes} onPress={() => setTimeout(check, 400)} />
      </Show>
    </>
  );
}

function Band(props: { dir: "up" | "down"; y: number; nodes: Set<unknown>; onPress: () => void }) {
  let node: unknown;
  const [pressed, setPressed] = createSignal(false);
  const over = () => hovered() === node;
  const down = props.dir === "down";
  const dark = () => (over() ? 0x000000cc : 0x00000059);
  onCleanup(() => props.nodes.delete(node));
  return (
    <>
      {/* The up band's fade starts at the very top, behind the top bar (no hard edge under it);
          only the part below the bar is the click target. */}
      <Show when={!down}>
        <View
          width={screen.width}
          height={props.y + BAND_H}
          colorTop={dark()}
          colorBottom={0x00000000}
          zIndex={9}
          skipFocus
        />
      </Show>
      <View
        ref={el => {
          node = el;
          props.nodes.add(el);
        }}
        y={props.y}
        width={screen.width}
        height={BAND_H}
        // Dark at the screen edge, fading toward the middle.
        colorTop={0x00000000}
        colorBottom={down ? dark() : 0x00000000}
        zIndex={60}
        skipFocus
        onPointerSelect={() => {
          setPressed(true);
          setTimeout(() => setPressed(false), 140);
          pageScroll(props.dir);
          props.onPress();
        }}
      >
        <View
          src={`images/icons/chevron-${props.dir}.svg`}
          x={(screen.width - ICON) / 2}
          y={(down ? BAND_H - ICON - 10 : 10) + (pressed() ? (down ? 6 : -6) : 0)}
          width={ICON}
          height={ICON}
          color={color.text}
          alpha={over() ? 1 : 0.45}
          transition={{ alpha: { duration: 150 }, y: { duration: 120 } }}
          zIndex={61}
        />
      </View>
    </>
  );
}

const SIDE_W = 140;

/** Left/right on the focused row: a fade at that screen edge, the row's height. */
function SideBand(props: {
  dir: "left" | "right";
  row: RowScroll;
  nodes: Set<unknown>;
  onPress: () => void;
}) {
  let node: unknown;
  const [pressed, setPressed] = createSignal(false);
  const over = () => hovered() === node;
  const right = props.dir === "right";
  const dark = () => (over() ? 0x000000f2 : 0x000000d9);
  onCleanup(() => props.nodes.delete(node));
  return (
    <View
      ref={el => {
        node = el;
        props.nodes.add(el);
      }}
      x={right ? screen.width - SIDE_W : 0}
      y={props.row.y}
      width={SIDE_W}
      height={props.row.height}
      colorLeft={right ? 0x00000000 : dark()}
      colorRight={right ? dark() : 0x00000000}
      zIndex={60}
      skipFocus
      onPointerSelect={() => {
        setPressed(true);
        setTimeout(() => setPressed(false), 140);
        rowScroll(props.dir);
        props.onPress();
      }}
    >
      {/* A soft shadow (the same chevron, dark, offset) keeps it readable on bright art. */}
      <View
        src={`images/icons/chevron-${props.dir}.svg`}
        x={(right ? SIDE_W - ICON - 22 : 22) + 2 + (pressed() ? (right ? 6 : -6) : 0)}
        y={(props.row.height - ICON) / 2 + 2}
        width={ICON}
        height={ICON}
        color={0x000000cc}
        zIndex={61}
      />
      <View
        src={`images/icons/chevron-${props.dir}.svg`}
        x={(right ? SIDE_W - ICON - 22 : 22) + (pressed() ? (right ? 6 : -6) : 0)}
        y={(props.row.height - ICON) / 2}
        width={ICON}
        height={ICON}
        color={color.text}
        scale={over() ? 1.15 : 1}
        transition={{ x: { duration: 120 }, scale: { duration: 120 } }}
        zIndex={62}
      />
    </View>
  );
}
