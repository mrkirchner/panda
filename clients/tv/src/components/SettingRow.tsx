import { createSignal, Show } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { FocusRing } from "./FocusRing";
import { OPTICAL_Y } from "./Label";
import { displayText } from "../format";
import { glassEdge, theme } from "../theme";

const { color, font } = theme;
export const ROW_W = 860;
export const ROW_H = 96;

/** A settings row: label on the left, current value and a chevron on the right. OK opens it. */
export function SettingRow(props: {
  label: string;
  value?: string;
  /** Right-hand icon: a chevron (opens a page) or a check (the current choice). */
  icon?: "chevron" | "check" | null;
  onSelect: () => void;
  ref?: (el: ElementNode) => void;
  onRight?: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const ink = () => (focused() ? color.focusText : color.text);
  return (
    <View
      ref={props.ref}
      width={ROW_W}
      height={ROW_H}
      borderRadius={theme.radius.md}
      color={focused() ? color.focusFill : theme.glass.thin}
      border={glassEdge(!focused())}
      transition={{ color: { duration: theme.focus.duration } }}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
      onRight={props.onRight}
    >
      <Text
        x={36}
        y={ROW_H / 2 + font.body * OPTICAL_Y}
        mountY={0.5}
        lineHeight={font.body}
        fontSize={font.body}
        color={ink()}
      >
        {props.label}
      </Text>
      <Text
        x={ROW_W - 76}
        y={ROW_H / 2 + font.body * OPTICAL_Y}
        mountX={1}
        mountY={0.5}
        lineHeight={font.body}
        fontSize={font.body}
        color={focused() ? color.focusText : color.textMuted}
      >
        {displayText(props.value ?? "") || " "}
      </Text>
      <Show when={props.icon}>
        <View
          src={`images/icons/${props.icon}.svg`}
          x={ROW_W - 58}
          y={(ROW_H - 32) / 2}
          width={32}
          height={32}
          // The check marking the current choice takes the accent.
          color={props.icon === "check" && !focused() ? color.accent : ink()}
        />
      </Show>
      <FocusRing width={ROW_W} height={ROW_H} radius={theme.radius.md} visible={focused()} />
    </View>
  );
}
