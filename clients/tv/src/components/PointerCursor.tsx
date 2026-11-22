import { createSignal, onCleanup } from "solid-js";
import { View, type ElementNode } from "@solidtv/solid";
import { logicalPixelRatio } from "#devices/resolution";
import { hovered } from "../pointer";

/** Pointer (public/images/cursor.svg, viewBox 32x32): a drop leaning up-left. */
const W = 52;
const H = 52;
/** The tip inside that box: this is the point that clicks. */
const TIP_X = 5 * (W / 32);
const TIP_Y = 3.5 * (H / 32);

/**
 * Pointer-mode cursor drawn in the canvas: a blue drop leaning up-left, white outline and
 * soft shadow (readable on any artwork). It tightens slightly over a selectable item and dips when
 * clicked. Mounted only in pointer mode; position is written straight to the node, so moving it
 * never re-renders.
 */
export function PointerCursor() {
  let node: ElementNode | undefined;
  const onTarget = () => Boolean(hovered());
  const [pressed, setPressed] = createSignal(false);

  const move = (e: MouseEvent) => {
    const x = e.clientX / logicalPixelRatio;
    const y = e.clientY / logicalPixelRatio;
    if (node) {
      node.x = x - TIP_X;
      node.y = y - TIP_Y;
    }
  };
  const down = () => setPressed(true);
  const up = () => setPressed(false);
  window.addEventListener("mousemove", move);
  window.addEventListener("mousedown", down);
  window.addEventListener("mouseup", up);
  onCleanup(() => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mousedown", down);
    window.removeEventListener("mouseup", up);
  });

  return (
    <View
      ref={node}
      src="images/cursor.svg"
      x={-100}
      y={-100}
      width={W}
      height={H}
      // Scale around the tip so the hotspot never moves.
      pivotX={TIP_X / W}
      pivotY={TIP_Y / H}
      zIndex={200}
      skipFocus
      scale={pressed() ? 0.82 : onTarget() ? 0.92 : 1}
      transition={{ scale: { duration: 120, easing: "ease-out" } }}
    />
  );
}
