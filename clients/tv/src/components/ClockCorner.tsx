import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { showFps } from "#devices/debug";
import { FPS_W, FpsBadge } from "./FpsMeter";
import { theme } from "../theme";

const { screen, color, font } = theme;
/** Where the top bar's row sits (TopBar: Y 34, height 52); the clock stays on it. */
const Y = 34;
const H = 52;
const GAP = 18;
const PAD = 18;
/** Clock text width (no measuring API: the caption size runs about this per character). */
const textW = (s: string) => s.length * 15;

function clock(): string {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/** How many visible top bars are on screen (they draw no pill behind the clock). */
const [topBars, setTopBars] = createSignal(0);

/** A top bar registers while it's visible: the clock then sits in it without a pill. */
export function useTopBarShown(visible: () => boolean) {
  let counted = false;
  createEffect(() => {
    const v = visible();
    if (v !== counted) setTopBars(n => n + (v ? 1 : -1));
    counted = v;
  });
  onCleanup(() => {
    if (counted) setTopBars(n => n - 1);
  });
}

/**
 * The clock (and the FPS meter beside it in dev builds), top right, on every page except the
 * player. It stays put while pages scroll: in the top bar's row when the bar is up, on a soft
 * glass pill over the content when it isn't.
 */
export function ClockCorner(props: { hidden?: boolean }) {
  const [time, setTime] = createSignal(clock());
  const timer = setInterval(() => setTime(clock()), 15_000);
  onCleanup(() => clearInterval(timer));
  const contentW = () => textW(time()) + (showFps() ? FPS_W + GAP : 0);
  const floating = () => topBars() === 0;
  const right = screen.width - screen.gutter;
  return (
    <View
      x={right - contentW() - PAD}
      y={Y}
      width={contentW() + PAD * 2}
      height={H}
      zIndex={900}
      borderRadius={H / 2}
      color={floating() ? theme.glass.regular : 0x00000000}
      alpha={props.hidden ? 0 : 1}
      skipFocus
    >
      <Show when={showFps()}>
        <FpsBadge x={PAD} y={(H - 32) / 2} />
      </Show>
      <Text
        x={contentW() + PAD}
        mountX={1}
        y={H / 2}
        mountY={0.5}
        fontSize={font.caption}
        lineHeight={font.caption}
        color={color.text}
        zIndex={901}
      >
        {time()}
      </Text>
    </View>
  );
}
