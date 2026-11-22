import { createSignal } from "solid-js";
import { renderer, Text, View } from "@solidtv/solid";
import { OPTICAL_Y } from "./Label";
import { theme } from "../theme";

const { color, font } = theme;
export const FPS_W = 112;
export const FPS_H = 32;
const SIZE = font.caption - 6;

/** The renderer's frame rate; the last measured one while nothing redraws. */
const [fps, setFps] = createSignal<number | null>(null);
let listening = false;
/** Subscribed once, from the first badge (the renderer doesn't exist when this module loads). */
function listen() {
  if (listening || !renderer) return;
  listening = true;
  renderer.on("fpsUpdate", (_: unknown, data: { fps: number; sampledFrames: number }) => {
    if (data.sampledFrames > 0) setFps(Math.round(data.fps));
  });
}

/** The meter itself, positioned by its parent (devices/debug.ts decides when it shows). */
export function FpsBadge(props: { x?: number; y?: number }) {
  listen();
  // Under 50 on a 60 Hz TV is worth a look; under 30 is visibly janky.
  const ink = () => {
    const f = fps();
    if (f === null) return color.textMuted;
    return f >= 50 ? color.text : f >= 30 ? color.accent : color.error;
  };
  return (
    <View
      x={props.x}
      y={props.y}
      width={FPS_W}
      height={FPS_H}
      zIndex={1000}
      borderRadius={theme.radius.sm}
      color={theme.glass.regular}
      skipFocus
    >
      <Text
        x={FPS_W / 2}
        mountX={0.5}
        y={FPS_H / 2 + SIZE * OPTICAL_Y}
        mountY={0.5}
        lineHeight={SIZE}
        fontSize={SIZE}
        color={ink()}
        zIndex={1001}
      >
        {fps() === null ? "-- fps" : `${fps()} fps`}
      </Text>
    </View>
  );
}
