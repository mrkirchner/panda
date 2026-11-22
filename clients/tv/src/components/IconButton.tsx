import { createSignal } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { theme, glassEdge } from "../theme";
import { FocusRing } from "./FocusRing";

const { color, focus } = theme;

/**
 * Round icon button (SVG in public/images/icons), glass at rest, white with a dark icon when
 * focused; what it does is written under it while focused. Player transport, title actions.
 * `z` lifts it above an overlay's scrim (the player's controls).
 */
export function IconButton(props: {
  icon: string;
  size: number;
  label: string;
  onSelect: () => void;
  ref?: (el: ElementNode) => void;
  z?: number;
}) {
  const [focused, setFocused] = createSignal(false);
  const icon = () => Math.round(props.size * 0.5);
  const z = () => props.z ?? 1;
  return (
    <View
      ref={props.ref}
      width={props.size}
      height={props.size}
      borderRadius={props.size / 2}
      color={focused() ? color.focusFill : theme.glass.regular}
      border={glassEdge(!focused())}
      zIndex={z()}
      scale={focused() ? 1.08 : 1}
      transition={{
        scale: { duration: focus.duration, easing: "ease-out" },
        color: { duration: focus.duration },
      }}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <View
        src={`images/icons/${props.icon}.svg`}
        x={(props.size - icon()) / 2}
        y={(props.size - icon()) / 2}
        width={icon()}
        height={icon()}
        color={focused() ? color.focusText : color.text}
        zIndex={z() + 1}
      />
      <FocusRing width={props.size} height={props.size} radius={props.size / 2} visible={focused()} />
      <Text
        x={props.size / 2}
        mountX={0.5}
        y={props.size + 16}
        fontSize={20}
        color={color.text}
        alpha={focused() ? 1 : 0}
        zIndex={z() + 1}
      >
        {props.label}
      </Text>
    </View>
  );
}
