import { createSignal } from "solid-js";
import { View } from "@solidtv/solid";
import { glassEdge, theme, withAlpha } from "../theme";
import { Label } from "./Label";
import { FocusRing } from "./FocusRing";

const { color, font, focus } = theme;
/** Pills ease their fill and size so focus visibly moves rather than jumping. */
const PILL_TRANSITION = {
  scale: { duration: focus.duration, easing: "ease-out" },
  color: { duration: focus.duration },
};

/**
 * Button: light fill with dark text when focused (tvOS style), glass otherwise. `primary` (the
 * page's main action: Play, Done, Request) is filled with the accent while not focused.
 * `danger` (destructive: Delete) is red: tinted at rest, solid red with white text focused.
 */
export function PillButton(props: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  width?: number;
  height?: number;
  onSelect: () => void;
  autofocus?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const h = () => props.height ?? 64;
  const fill = () => {
    if (props.danger) return focused() ? color.error : withAlpha(color.error, 0x2e);
    if (focused()) return color.focusFill;
    return props.primary ? color.accent : color.chip;
  };
  const ink = () => {
    if (props.danger) return focused() ? color.text : color.error;
    if (focused()) return color.focusText;
    return props.primary ? color.accentText : color.text;
  };
  return (
    <View
      width={props.width ?? 220}
      height={h()}
      borderRadius={theme.radius.sm}
      color={fill()}
      border={glassEdge(!focused() && !props.primary && !props.danger)}
      scale={focused() ? 1.05 : 1}
      transition={PILL_TRANSITION}
      autofocus={props.autofocus}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <Label text={props.label} width={props.width ?? 220} height={h()} size={font.body} color={ink()} />
      <FocusRing width={props.width ?? 220} height={h()} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}

/**
 * Small pill for tabs (e.g. seasons). Focusing it selects it, like tvOS tabs; `selected`
 * keeps it highlighted while focus is elsewhere.
 */
export function Chip(props: { label: string; selected: boolean; onFocused: () => void; width?: number }) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width ?? 180;
  return (
    <View
      width={w()}
      height={52}
      borderRadius={theme.radius.sm}
      // Selected: a glass highlight (gold is kept for actions, like Play right above).
      color={focused() ? color.focusFill : props.selected ? theme.glass.thick : 0x00000000}
      transition={PILL_TRANSITION}
      // OK (and a pointer click) selects too. The pointer only hovers nodes with onEnter.
      onEnter={() => {
        props.onFocused();
        return true;
      }}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused();
      }}
    >
      <Label
        text={props.label}
        width={w()}
        height={52}
        size={font.caption}
        color={focused() ? color.focusText : props.selected ? color.text : color.textMuted}
      />
      <FocusRing width={w()} height={52} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}

/** Small pill for filters: OK selects; `active` marks the current choice. */
export function ToggleChip(props: { label: string; active: boolean; onSelect: () => void; width?: number }) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width ?? 170;
  return (
    <View
      width={w()}
      height={48}
      borderRadius={theme.radius.sm}
      color={focused() ? color.focusFill : props.active ? color.accent : color.chip}
      border={glassEdge(!focused() && !props.active)}
      transition={PILL_TRANSITION}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <Label
        text={props.label}
        width={w()}
        height={48}
        size={22}
        color={focused() ? color.focusText : props.active ? color.accentText : color.text}
      />
      <FocusRing width={w()} height={48} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}

/**
 * Page tab (More Like This, Cast & Crew, Details): text, with a gold underline on the selected
 * one, so tabs never look like buttons. Focusing a tab selects it (tvOS style); focus is the
 * usual white pill.
 */
export function Tab(props: {
  label: string;
  selected: boolean;
  onFocused: () => void;
  /** OK on the tab (default: the same as focusing it). */
  onEnter?: () => void;
  width?: number;
}) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width ?? 200;
  const H = 52;
  return (
    <View
      width={w()}
      height={H}
      borderRadius={theme.radius.sm}
      color={focused() ? color.focusFill : 0x00000000}
      transition={{ color: { duration: focus.duration } }}
      onEnter={() => {
        (props.onEnter ?? props.onFocused)();
        return true;
      }}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused();
      }}
    >
      <Label
        text={props.label}
        width={w()}
        height={H}
        size={font.body}
        color={focused() ? color.focusText : props.selected ? color.text : color.textMuted}
      />
      {/* The selected tab's underline (hidden under focus, where the pill says it). */}
      <View
        x={20}
        y={H + 4}
        width={w() - 40}
        height={4}
        borderRadius={2}
        color={color.accent}
        alpha={props.selected && !focused() ? 1 : 0}
        transition={{ alpha: { duration: focus.duration } }}
      />
      <FocusRing width={w()} height={H} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}
