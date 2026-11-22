import { createSignal, For } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { t } from "../i18n";
import { glassEdge, theme } from "../theme";
import { PillButton } from "./Button";
import { FocusRing } from "./FocusRing";
import { OPTICAL_Y } from "./Label";

const { screen, color, font } = theme;
const W = 760;
const ROW_H = 64;
const ROW_GAP = theme.space.list;
/** Up to seven rows show at once ("All seasons" and six seasons: most shows, no scrolling). */
const LIST_H = 7 * (ROW_H + ROW_GAP) - ROW_GAP;
/** Where the list starts: under the heading and the show's name, a block's space below. */
const LIST_Y = 100 + font.caption + theme.space.block;
/** Room around the clipped list for a focused row's ring (offset + width). */
const RING = 12;
/** Opaque: page text draws in its own pass and would show through a translucent panel. */
const PANEL = (color.surface | 0xff) >>> 0;

/** A checkable line: the label, and a check box on the right. */
function CheckRow(props: { label: string; checked: boolean; onToggle: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const ink = () => (focused() ? color.focusText : color.text);
  return (
    <View
      width={W - 120}
      height={ROW_H}
      borderRadius={theme.radius.sm}
      color={focused() ? color.focusFill : theme.glass.thin}
      onFocusChanged={setFocused}
      onEnter={() => (props.onToggle(), true)}
      zIndex={42}
    >
      <Text
        x={24}
        y={ROW_H / 2 + font.body * OPTICAL_Y}
        mountY={0.5}
        lineHeight={font.body}
        fontSize={font.body}
        color={ink()}
        zIndex={43}
      >
        {props.label}
      </Text>
      <View
        x={W - 120 - 60}
        y={(ROW_H - 32) / 2}
        width={32}
        height={32}
        borderRadius={8}
        color={props.checked ? color.accent : 0x00000000}
        border={
          props.checked
            ? { width: 0, color: 0 }
            : { width: 2, color: focused() ? color.focusText : theme.glass.edge }
        }
        zIndex={43}
      >
        <View
          src="images/icons/check.svg"
          x={6}
          y={6}
          width={20}
          height={20}
          color={color.accentText}
          alpha={props.checked ? 1 : 0}
          zIndex={44}
        />
      </View>
      <FocusRing width={W - 120} height={ROW_H} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}

/**
 * Which seasons to get when requesting a show: All (the default), or any of them. Picking a
 * season unticks All; ticking All picks every one. Request sends `null` for all, else the list.
 */
export function SeasonPicker(props: {
  title: string;
  /** The seasons to choose from (all of a show, or the ones you don't have). */
  seasons: number[];
  /** Heading (default "Which seasons?"). */
  heading?: string;
  onRequest: (seasons: number[] | null) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = createSignal<Set<number>>(new Set());
  const all = () => picked().size === 0 || picked().size === props.seasons.length;
  const toggle = (n: number) =>
    setPicked(p => {
      const next = new Set(all() ? [] : p);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const numbers = () => props.seasons;
  const listH = () => Math.min(LIST_H, (props.seasons.length + 1) * (ROW_H + ROW_GAP) - ROW_GAP);
  /** Heading, the list, a block's space, the buttons and the panel's padding. */
  const H = () => LIST_Y + listH() + theme.space.block + 64 + 40;
  let list: ElementNode | undefined;
  let buttons: ElementNode | undefined;
  return (
    <View width={screen.width} height={screen.height} zIndex={40} onBack={() => (props.onCancel(), true)}>
      <View width={screen.width} height={screen.height} color={0x000000cc} zIndex={40} skipFocus />
      <View
        x={(screen.width - W) / 2}
        y={(screen.height - H()) / 2}
        width={W}
        height={H()}
        borderRadius={theme.radius.lg}
        color={PANEL}
        border={glassEdge(true)}
        zIndex={41}
      >
        <Text
          x={60}
          y={48}
          width={W - 120}
          contain="width"
          maxLines={1}
          fontSize={font.heading}
          color={color.text}
          zIndex={42}
        >
          {props.heading ?? t("Which seasons?")}
        </Text>
        <Text
          x={60}
          y={100}
          width={W - 120}
          contain="width"
          maxLines={1}
          fontSize={font.caption}
          color={color.textMuted}
          zIndex={42}
        >
          {props.title}
        </Text>
        {/* Clipped with room around it, so a focused row's ring isn't cut at the edges. */}
        <View
          x={60 - RING}
          y={LIST_Y - RING}
          width={W - 120 + RING * 2}
          height={listH() + RING * 2}
          clipping
          zIndex={42}
          forwardFocus={0}
        >
          <Column
            x={RING}
            y={RING}
            ref={el => (list = el)}
            width={W - 120}
            gap={ROW_GAP}
            scroll="auto"
            autofocus
            // Down from the last season: the Request / Cancel buttons (the panel around them is a
            // plain view, which doesn't move focus between them).
            onDown={function (this: ElementNode) {
              const last = (this.children?.length ?? 1) - 1;
              return (this.selected ?? 0) >= last ? (buttons?.setFocus(), true) : false;
            }}
          >
            <CheckRow
              label={t("All seasons")}
              checked={all()}
              onToggle={() => setPicked(new Set<number>())}
            />
            <For each={numbers()}>
              {n => (
                <CheckRow
                  label={t("Season {n}", { n })}
                  checked={!all() && picked().has(n)}
                  onToggle={() => toggle(n)}
                />
              )}
            </For>
          </Column>
        </View>
        <Row
          ref={el => (buttons = el)}
          x={60}
          y={H() - 64 - 40}
          width={W - 120}
          height={64}
          gap={theme.space.item}
          scroll="none"
          zIndex={42}
          onUp={() => (list?.setFocus(), true)}
        >
          <PillButton
            primary
            label={t("Request")}
            width={260}
            onSelect={() => props.onRequest(all() ? null : [...picked()].sort((a, b) => a - b))}
          />
          <PillButton label={t("Cancel")} width={220} onSelect={props.onCancel} />
        </Row>
      </View>
    </View>
  );
}
