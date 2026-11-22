import { View } from "@solidtv/solid";
import { theme } from "../theme";

const { focus } = theme;

/**
 * The focus border: a light outline drawn just outside a focusable shape. Put it as the last
 * child of the node it rings so it draws above artwork. Always mounted (alpha fades it), so
 * moving focus never builds nodes.
 */
export function FocusRing(props: {
  width: number;
  height: number;
  radius: number;
  visible: boolean;
  /** Ring weight; big round things (avatars) use `focus.ringWidthRound` so it reads as strongly. */
  ringWidth?: number;
}) {
  const o = focus.offset;
  return (
    <View
      x={-o}
      y={-o}
      width={props.width + o * 2}
      height={props.height + o * 2}
      borderRadius={props.radius + o}
      color={0x00000000}
      border={{ width: props.ringWidth ?? focus.ringWidth, color: theme.color.focusFill }}
      alpha={props.visible ? 1 : 0}
      // Width eases too, so the ring follows a tile that widens on focus (ExpandCard).
      transition={{
        alpha: { duration: focus.duration },
        width: { duration: focus.expandDuration, easing: "ease-out" },
      }}
      // Above its owner's fill (which may itself be layered, e.g. player buttons).
      zIndex={30}
      skipFocus
    />
  );
}
