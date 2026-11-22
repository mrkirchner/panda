import { createSignal, For, onCleanup } from "solid-js";
import { View } from "@solidtv/solid";
import { theme } from "../theme";

const STEP_MS = 180;

/**
 * Loading animation: three dots lighting up in a wave. Mount it only while loading; the timer
 * stops when it unmounts. Centered on (x, y).
 */
export function Loader(props: { x: number; y: number; size?: number; zIndex?: number }) {
  const size = () => props.size ?? 18;
  const gap = () => size() * 0.9;
  const [phase, setPhase] = createSignal(0);
  const timer = setInterval(() => setPhase(p => (p + 1) % 3), STEP_MS);
  onCleanup(() => clearInterval(timer));
  const width = () => size() * 3 + gap() * 2;
  return (
    <View
      x={props.x - width() / 2}
      y={props.y - size() / 2}
      width={width()}
      height={size()}
      zIndex={props.zIndex ?? 30}
      skipFocus
    >
      <For each={[0, 1, 2]}>
        {i => (
          <View
            x={i * (size() + gap())}
            width={size()}
            height={size()}
            borderRadius={size() / 2}
            color={theme.color.accent}
            alpha={phase() === i ? 1 : 0.3}
            scale={phase() === i ? 1.25 : 1}
            transition={{ alpha: { duration: STEP_MS * 1.5 }, scale: { duration: STEP_MS * 1.5 } }}
            zIndex={props.zIndex ?? 30}
          />
        )}
      </For>
    </View>
  );
}
