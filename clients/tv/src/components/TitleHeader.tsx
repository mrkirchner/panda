import { For, Show, type JSX } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { displayText } from "../format";
import { MetaLine, type MetaPart } from "./MetaLine";
import { TitleLogo } from "./TitleLogo";
import { theme } from "../theme";

const { screen, color, font } = theme;

export interface TitleHeaderProps {
  title: string;
  /** Small label above the title, e.g. why a hero slide is featured ("Top rated"). */
  eyebrow?: string;
  /** "2019  |  2h 9m  |  Drama" */
  meta?: string;
  /** The facts as parts, ratings drawn as badges (instead of `meta`). */
  metaParts?: MetaPart[];
  /** Set (even to null while loading): the title's logo replaces its name once it loads. */
  logo?: string | null;
  /** Lower right: "Starring" and "Director" with names. */
  credits?: { label: string; names: string }[];
  overview?: string | null;
  /** y of the button row; the text stacks upwards from just above it. */
  buttonsY: number;
  /** Right on the last button (e.g. the carousel's "next title"). */
  onRightEdge?: () => void;
  /** Left on the first button (e.g. "previous title"). Unset: Left bubbles up. */
  onLeftEdge?: () => void;
  ref?: (el: ElementNode) => void;
  autofocus?: boolean;
  /**
   * Shorter header for pages with content under it (show pages): a one-line, smaller title
   * and a two-line overview, so the block never climbs into the avatar/clock corner.
   */
  compact?: boolean;
  /** PillButtons. */
  children: JSX.Element;
}

/**
 * The title block used everywhere a title is presented (home hero, movie and show pages):
 * title, details and overview stacked above a row of pill buttons. The text is a flex column
 * anchored to its bottom edge, so spacing stays the same whatever the title length, and a
 * missing overview leaves no gap.
 *
 * The button row is the first child, so `forwardFocus={0}` on the root lands on a button.
 */
export function TitleHeader(props: TitleHeaderProps) {
  let row: ElementNode | undefined;
  return (
    <View width={screen.width} height={props.buttonsY + 70} forwardFocus={0}>
      <Row
        ref={(el: ElementNode) => {
          row = el;
          props.ref?.(el);
        }}
        x={screen.gutter}
        y={props.buttonsY}
        width={screen.width - screen.gutter * 2}
        height={70}
        gap={theme.space.item}
        scroll="none"
        autofocus={props.autofocus}
        onLeft={() => {
          if (!row || !props.onLeftEdge || (row.selected ?? 0) > 0) return false;
          props.onLeftEdge();
          return true;
        }}
        onRight={() => {
          // Let the Row move between buttons; only the last button hands Right to the page.
          if (!row || !props.onRightEdge || (row.selected ?? 0) < row.children.length - 1) return false;
          props.onRightEdge();
          return true;
        }}
      >
        {props.children}
      </Row>
      <View
        x={screen.gutter}
        y={props.buttonsY - 36}
        mountY={1}
        width={1000}
        display="flex"
        flexDirection="column"
        flexBoundary="contain"
        gap={18}
      >
        <Show when={props.eyebrow}>
          <Text fontSize={font.caption} color={color.focusFill} letterSpacing={2}>
            {(props.eyebrow ?? "").toUpperCase()}
          </Text>
        </Show>
        <Show
          when={props.logo !== undefined}
          fallback={
            <Text
              width={props.compact ? 1400 : 1000}
              contain="width"
              maxLines={props.compact ? 1 : 2}
              fontSize={props.compact ? 64 : 84}
              // Tight leading: a two-line title reads as one block, not two separate lines.
              lineHeight={props.compact ? 70 : 92}
              color={color.text}
            >
              {displayText(props.title) || " "}
            </Text>
          }
        >
          <TitleLogo src={props.logo} title={props.title} maxWidth={1000} maxHeight={200} />
        </Show>
        <Show when={props.metaParts}>
          {/* A little more room under the title; the facts, then the ratings on their own line. */}
          <View height={6} />
          <MetaLine parts={props.metaParts!.filter(p => typeof p === "string")} />
          <Show when={props.metaParts!.some(p => typeof p !== "string")}>
            <MetaLine parts={props.metaParts!.filter(p => typeof p !== "string")} />
          </Show>
        </Show>
        <Show when={!props.metaParts && props.meta}>
          <Text width={1300} contain="width" maxLines={1} fontSize={font.caption} color={color.textMuted}>
            {displayText(props.meta)}
          </Text>
        </Show>
        <Show when={props.overview}>
          <Text
            width={900}
            contain="width"
            maxLines={props.compact ? 2 : 3}
            lineHeight={font.body * 1.35}
            fontSize={font.body}
            color={color.text}
          >
            {displayText(props.overview)}
          </Text>
        </Show>
      </View>
      <Show when={props.credits?.length}>
        <View
          x={screen.width - screen.gutter - CREDITS_W}
          y={props.buttonsY + 70}
          mountY={1}
          width={CREDITS_W}
          display="flex"
          flexDirection="column"
          flexBoundary="contain"
          gap={14}
        >
          <For each={props.credits}>
            {c => (
              <View width={CREDITS_W} display="flex" flexDirection="column" flexBoundary="contain" gap={2}>
                <Text fontSize={font.caption} color={color.textMuted}>
                  {c.label}
                </Text>
                <Text
                  width={CREDITS_W}
                  contain="width"
                  maxLines={2}
                  fontSize={font.caption}
                  color={color.text}
                >
                  {displayText(c.names)}
                </Text>
              </View>
            )}
          </For>
        </View>
      </Show>
    </View>
  );
}

/** Width of the credits block on the right. */
const CREDITS_W = 520;
