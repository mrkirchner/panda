import { createSignal } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { FocusRing } from "./FocusRing";
import { OPTICAL_Y } from "./Label";
import { displayText } from "../format";
import { glassEdge, theme } from "../theme";

const { color, font } = theme;
export const FIELD_W = 760;
export const FIELD_H = 84;
/** Where the value starts: room for the label on the left. */
const VALUE_X = 220;

/**
 * A text field: label on the left, what's typed on the right; OK opens the keyboard (the page
 * owns the `KeyboardSheet` and sets `active` while it's typing into this field).
 */
export function TextField(props: {
  label: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  active: boolean;
  onSelect: () => void;
  ref?: (el: ElementNode) => void;
  width?: number;
}) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width ?? FIELD_W;
  const ink = () => (focused() ? color.focusText : color.text);
  const shown = () => (props.secret ? "•".repeat(props.value.length) : displayText(props.value));
  return (
    <View
      ref={props.ref}
      width={w()}
      height={FIELD_H}
      borderRadius={theme.radius.md}
      color={focused() ? color.focusFill : props.active ? theme.glass.regular : theme.glass.thin}
      border={glassEdge(!focused())}
      onFocusChanged={setFocused}
      onEnter={() => {
        props.onSelect();
        return true;
      }}
    >
      <Text
        x={32}
        y={FIELD_H / 2 + font.caption * OPTICAL_Y}
        mountY={0.5}
        lineHeight={font.caption}
        fontSize={font.caption}
        color={focused() ? color.focusText : color.textMuted}
      >
        {props.label}
      </Text>
      <Text
        x={VALUE_X}
        y={FIELD_H / 2 + font.body * OPTICAL_Y}
        mountY={0.5}
        maxWidth={w() - VALUE_X - 40}
        contain="width"
        maxLines={1}
        lineHeight={font.body}
        fontSize={font.body}
        color={props.value ? ink() : focused() ? color.focusText : color.textMuted}
      >
        {(props.value ? shown() : props.placeholder) + (props.active ? "_" : "")}
      </Text>
      <FocusRing width={w()} height={FIELD_H} radius={theme.radius.md} visible={focused()} />
    </View>
  );
}
