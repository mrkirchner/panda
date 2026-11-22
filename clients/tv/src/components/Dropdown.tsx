import { createSignal, For } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { theme, withAlpha } from "../theme";
import { OPTICAL_Y } from "./Label";

const { screen, color, font, focus } = theme;
const ROW_H = 56;
const ROW_GAP = 4;
const PAD = 12;
/** How far the menu slides while it opens and closes. */
const SLIDE = 14;

export interface DropdownOption {
  label: string;
  active: boolean;
  choose: () => void;
}

/** One choice: white when focused (like every focusable), a gold check on the current one. */
function DropdownRow(props: { option: DropdownOption; width: number }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={props.width}
      height={ROW_H}
      borderRadius={theme.radius.sm}
      color={focused() ? color.focusFill : 0x00000000}
      transition={{ color: { duration: focus.duration } }}
      onFocusChanged={setFocused}
      onEnter={() => (props.option.choose(), true)}
      zIndex={42}
    >
      <Text
        x={20}
        y={ROW_H / 2 + font.body * OPTICAL_Y}
        mountY={0.5}
        maxWidth={props.width - 80}
        contain="width"
        maxLines={1}
        lineHeight={font.body}
        fontSize={font.body}
        color={focused() ? color.focusText : props.option.active ? color.text : color.textMuted}
        zIndex={43}
      >
        {props.option.label}
      </Text>
      <View
        src="images/icons/check.svg"
        x={props.width - 48}
        y={(ROW_H - 28) / 2}
        width={28}
        height={28}
        color={focused() ? color.focusText : color.accent}
        alpha={props.option.active ? 1 : 0}
        zIndex={43}
      />
    </View>
  );
}

/**
 * A menu that drops from the chip that opened it (Sort, Genre, Library...): a solid panel
 * sized to its choices (scrolling when long), fading and sliding in and out, over a light
 * dimming of the page. Always mounted, so opening never builds nodes. OK chooses; Back or
 * Left closes.
 */
export function Dropdown(props: {
  open: boolean;
  /** Top-left corner: just under the chip. */
  x: number;
  y: number;
  width?: number;
  options: DropdownOption[];
  onClose: () => void;
  ref: (el: ElementNode) => void;
}) {
  const w = () => props.width ?? 420;
  const rowsH = () => props.options.length * (ROW_H + ROW_GAP) - ROW_GAP;
  const maxH = () => screen.height - props.y - 60 - PAD * 2;
  const listH = () => Math.min(rowsH(), maxH());
  return (
    <>
      {/* Dims the page so the menu reads as on top. */}
      <View
        width={screen.width}
        height={screen.height}
        color={0x00000073}
        alpha={props.open ? 1 : 0}
        transition={{ alpha: { duration: 180 } }}
        zIndex={39}
        skipFocus
      />
      <View
        x={props.x}
        y={props.y + (props.open ? 0 : -SLIDE)}
        width={w()}
        height={listH() + PAD * 2}
        pivotY={0}
        scale={props.open ? 1 : 0.96}
        alpha={props.open ? 1 : 0}
        skipFocus={!props.open}
        transition={{
          alpha: { duration: 160 },
          y: { duration: 200, easing: "ease-out" },
          scale: { duration: 200, easing: "ease-out" },
        }}
        zIndex={40}
      >
        {/* Soft shadow, then the solid panel with a hairline edge. */}
        <View
          x={-10}
          y={4}
          width={w() + 20}
          height={listH() + PAD * 2 + 20}
          borderRadius={theme.radius.md + 10}
          color={withAlpha(color.shadow, 0x59)}
          zIndex={40}
        />
        <View
          width={w()}
          height={listH() + PAD * 2}
          borderRadius={theme.radius.md}
          color={withAlpha(color.raised, 0xff)}
          border={{ width: 2, color: theme.glass.edge }}
          zIndex={41}
          clipping
        >
          <Column
            ref={props.ref}
            x={PAD}
            y={PAD}
            width={w() - PAD * 2}
            height={listH()}
            gap={ROW_GAP}
            scroll="auto"
            // Opens on the current choice.
            selected={Math.max(
              0,
              props.options.findIndex(o => o.active),
            )}
            onBack={() => (props.onClose(), true)}
            onLeft={() => (props.onClose(), true)}
            onRight={() => true}
            zIndex={42}
          >
            <For each={props.options}>{o => <DropdownRow option={o} width={w() - PAD * 2} />}</For>
          </Column>
        </View>
      </View>
    </>
  );
}
