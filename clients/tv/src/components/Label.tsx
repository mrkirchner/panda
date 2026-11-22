import { Text } from "@solidtv/solid";
import { theme } from "../theme";

/**
 * Nudge from the box's center to where text looks centered: capitals sit above the line
 * box's middle because of the space reserved for descenders. Tuned once for the Roboto atlases.
 */
export const OPTICAL_Y = -0.04;

/**
 * Text centered in a box, horizontally and vertically. Every button, chip, key and avatar
 * letter uses this so labels line up the same everywhere (the SDF renderer can't center
 * vertically by itself, so the text is mounted at its middle).
 */
export function Label(props: {
  text: string;
  width: number;
  height: number;
  size?: number;
  color?: number;
  x?: number;
  alpha?: number;
  zIndex?: number;
}) {
  const size = () => props.size ?? theme.font.body;
  return (
    <Text
      x={(props.x ?? 0) + props.width / 2}
      y={props.height / 2 + size() * OPTICAL_Y}
      mountX={0.5}
      mountY={0.5}
      maxWidth={props.width - 16}
      contain="width"
      maxLines={1}
      textAlign="center"
      lineHeight={size()}
      fontSize={size()}
      color={props.color ?? theme.color.text}
      alpha={props.alpha ?? 1}
      zIndex={props.zIndex}
    >
      {props.text || " "}
    </Text>
  );
}
