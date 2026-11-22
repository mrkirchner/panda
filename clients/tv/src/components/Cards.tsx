import {
  previewing,
  previewsEnabled,
  startPreview,
  stopPreview,
  type PreviewSource,
} from "../playback/preview";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { hovered, pointerMode } from "../pointer";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";
import { FocusRing } from "./FocusRing";
import { Artwork } from "./Artwork";

const { color, font, focus } = theme;
const RADIUS = theme.tile.radius;

/** A tick drawn from two rotated bars (the MSDF fonts are ASCII-only, so no glyph). */
export function CheckMark(props: { x: number; y: number; color?: number }) {
  const c = () => props.color ?? color.focusFill;
  return (
    <View x={props.x} y={props.y} width={20} height={16}>
      <View x={1} y={8} width={9} height={4} borderRadius={2} color={c()} rotation={Math.PI / 4} />
      <View x={5} y={6} width={16} height={4} borderRadius={2} color={c()} rotation={-Math.PI / 4} />
    </View>
  );
}

/** Thin bar along the bottom of a card. */
function ProgressBar(props: { width: number; y: number; fraction: number }) {
  return (
    <View x={14} y={props.y} width={props.width - 28} height={6} borderRadius={3} color={0x00000099}>
      <View
        width={Math.max(6, (props.width - 28) * props.fraction)}
        height={6}
        borderRadius={3}
        color={color.accent}
      />
    </View>
  );
}

/**
 * Card shapes, so rows don't all look alike:
 * - `poster`: 2:3 artwork.
 * - `wide`: 16:9 artwork with title and subtitle underneath (Continue Watching).
 * - `landscape`: 16:9 backdrop with the title drawn on it over a scrim (shows, spotlight rows).
 * - `large`: a bigger 2:3 poster, for rows that should stand out.
 * - `expand`: a tall poster that widens into its 16:9 backdrop with details underneath when
 *   focused (see ExpandCard).
 */
export type CardVariant = "poster" | "wide" | "landscape" | "large" | "expand" | "tall" | "genre";

/** Extra height under the artwork for the caption lines of a `wide` card. */
export const CAPTION_H = 70;

/** Room left of a ranked card for its number (see CardRow's `ranked`). */
export const RANK_W = 120;

export interface CardProps {
  width: number;
  height: number;
  image?: string;
  /** Shown on the card when there's no artwork (and under wide cards). */
  title: string;
  subtitle?: string;
  /** 0-1; omitted or 0 = no bar. */
  progress?: number;
  watched?: boolean;
  onSelect: () => void;
  onFocused?: () => void;
  /** The data item, set on the root node: virtual lists find children by it (scrollToIndex). */
  item?: unknown;
  /** Its place in a top ten row (1-10), drawn big beside it. */
  rank?: number;
  /** Short status along the artwork's bottom edge (e.g. "Downloading 42%"). */
  badge?: string;
  /** action: something to do ("Request", gold); pending: on its way; done: downloaded. */
  badgeTone?: BadgeTone;
  /** `expand` cards: the 16:9 artwork shown when open, and a details line under it. */
  backdrop?: string;
  meta?: string;
  /** `expand` cards: the title whose preview clip plays once the card has been open a moment. */
  preview?: PreviewSource;
  /** `tall` cards: the title's logo, and why it's featured (under `meta`). */
  logo?: string;
  reason?: string;
  /** `genre` tiles: the color washed over the artwork. */
  tint?: number;
}

/** A card with focus ring, grow-on-focus, progress bar and watched check. */
export type BadgeTone = "action" | "pending" | "done";
/** The request badge: an icon in a dark disc in the top-right corner (clear of the poster's
 * title art, usually at the bottom); focused, it widens into a pill with its word. */
const DISC = 36;
const BADGE_INSET = 10;
const BADGE_ICON = 20;
/** The icon tells the state (white on the dark disc, readable on any poster). */
const BADGE_TONES: Record<BadgeTone, { icon: string }> = {
  action: { icon: "download" },
  pending: { icon: "clock" },
  done: { icon: "check" },
};

export function Card(props: CardProps & { variant?: CardVariant }) {
  const [artMissing, setArtMissing] = createSignal(false);
  const tone = () => BADGE_TONES[props.badgeTone ?? "pending"];
  const [focused, setFocused] = createSignal(false);
  const variant = () => props.variant ?? "poster";
  const captioned = () => variant() === "wide";
  const overlaid = () => variant() === "landscape";
  return (
    <View
      item={props.item}
      width={props.width}
      height={props.height + (captioned() ? CAPTION_H : 0)}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused?.();
      }}
      onEnter={() => (props.onSelect(), true)}
    >
      {/* Top ten rows: the rank, big, to the card's left (the row leaves room: RANK_W). */}
      <Show when={props.rank}>
        <Text
          x={-RANK_W + 6}
          y={props.height + 18}
          mountY={1}
          width={RANK_W + 24}
          contain="width"
          textAlign="right"
          fontSize={props.rank! >= 10 ? 170 : 230}
          fontFamily="Roboto700"
          letterSpacing={props.rank! >= 10 ? -14 : 0}
          color={focused() ? color.text : 0xffffff59}
          transition={{ color: { duration: focus.duration } }}
        >
          {String(props.rank)}
        </Text>
      </Show>
      <View
        width={props.width}
        height={props.height}
        borderRadius={RADIUS}
        color={color.surface}
        // Big 16:9 cards grow less, so every card gains about the same few pixels.
        scale={
          focused() ? (variant() === "poster" || variant() === "large" ? focus.scale : focus.scaleWide) : 1
        }
        transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
      >
        <Artwork
          src={props.image}
          title={props.title}
          width={props.width}
          height={props.height}
          radius={RADIUS}
          onMissing={setArtMissing}
        />
        {/* The title overlay only on real artwork: the fallback poster shows the title itself. */}
        <Show when={props.image && !artMissing()}>
          <Show when={overlaid()}>
            <View
              y={props.height * 0.45}
              width={props.width}
              height={props.height * 0.55}
              borderRadius={RADIUS}
              colorTop={0x00000000}
              colorBottom={0x000000d0}
            />
            <Text
              x={20}
              y={props.height - (props.subtitle ? 78 : 50)}
              width={props.width - 40}
              contain="width"
              maxLines={1}
              fontSize={font.body}
              color={color.text}
            >
              {displayText(props.title)}
            </Text>
            <Show when={props.subtitle}>
              <Text
                x={20}
                y={props.height - 42}
                width={props.width - 40}
                contain="width"
                maxLines={1}
                fontSize={20}
                color={color.textMuted}
              >
                {displayText(props.subtitle)}
              </Text>
            </Show>
          </Show>
        </Show>
        {/* Badge: top-right; the word joins the icon when focused (flex sizes the pill). */}
        <Show when={props.badge}>
          <View
            x={props.width - BADGE_INSET}
            y={BADGE_INSET}
            mountX={1}
            height={DISC}
            display="flex"
            flexDirection="row"
            alignItems="center"
            flexBoundary="contain"
            gap={8}
            borderRadius={DISC / 2}
            color={0x000000d9}
          >
            <View width={(DISC - BADGE_ICON) / 2 - 8} height={DISC} />
            <Show when={focused()}>
              <View width={4} height={DISC} />
              <Text lineHeight={DISC} fontSize={21} color={color.text}>
                {props.badge ?? " "}
              </Text>
            </Show>
            <View
              // `?badge`: its own copy (SVGs are rasterized once, at the first user's size, and
              // these icons appear elsewhere at other sizes).
              src={`images/icons/${tone().icon}.svg?badge${BADGE_ICON}`}
              width={BADGE_ICON}
              height={BADGE_ICON}
              color={color.text}
            />
            <View width={(DISC - BADGE_ICON) / 2 - 8} height={DISC} />
          </View>
        </Show>
        <Show when={(props.progress ?? 0) > 0.005}>
          <ProgressBar width={props.width} y={props.height - 18} fraction={props.progress ?? 0} />
        </Show>
        <Show when={props.watched}>
          <View x={props.width - 46} y={10} width={36} height={36} borderRadius={18} color={0x000000aa}>
            <CheckMark x={9} y={10} />
          </View>
        </Show>
        <FocusRing width={props.width} height={props.height} radius={RADIUS} visible={focused()} />
      </View>
      <Show when={captioned()}>
        <Text
          y={props.height + 14}
          width={props.width}
          contain="width"
          maxLines={1}
          fontSize={font.caption}
          color={color.text}
        >
          {displayText(props.title)}
        </Text>
        <Text
          y={props.height + 44}
          width={props.width}
          contain="width"
          maxLines={1}
          fontSize={20}
          color={color.textMuted}
        >
          {displayText(props.subtitle) || " "}
        </Text>
      </Show>
    </View>
  );
}

/** Sizes of an `expand` card: closed it's a tall poster, open it's 16:9 at the same height. */
/** How long an open card rests before its preview clip starts (after it has finished opening). */
const CARD_PREVIEW_DELAY_MS = 1200;
export const EXPAND = { width: 240, height: 360, open: 640 };
/** How far an open card pushes the cards after it. */
export const EXPAND_EXTRA = EXPAND.open - EXPAND.width;
/** Details line under an open card. */
export const EXPAND_CAPTION_H = 52;

/**
 * `on`, but turning true only after `ms` (false at once). Text draws in one pass above every
 * shape, so an open card's title and details would show through the neighbours while the
 * card is still sliding; they appear once it has settled and vanish the moment it closes.
 */
function settled(on: () => boolean, ms: number) {
  const [value, setValue] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    clearTimeout(timer);
    if (on()) timer = setTimeout(() => setValue(true), ms);
    else setValue(false);
  });
  onCleanup(() => clearTimeout(timer));
  return value;
}

/**
 * Poster that opens into its backdrop on focus, like a featured row. The node keeps its
 * closed width for the row's layout (so a virtual row's scrolling stays exact); the open
 * artwork draws past it, and the row slides the following cards right by EXPAND_EXTRA
 * (`shiftX`). `pointerWidth`/`pointerX` keep the Magic Remote hit area on what's drawn.
 */
export function ExpandCard(props: CardProps & { shiftX: number; onOpenChanged?: (open: boolean) => void }) {
  const [focused, setFocused] = createSignal(false);
  let root: unknown;
  // With the remote it opens when focused; in pointer mode only while the pointer is on it
  // (a row taking focus doesn't open its first card under you).
  const open = () => focused() && Boolean(props.backdrop) && (!pointerMode() || hovered() === root);
  createEffect(on(open, o => props.onOpenChanged?.(o), { defer: true }));
  const w = () => (open() ? EXPAND.open : EXPAND.width);
  const showText = settled(open, focus.expandDuration);
  // Preview clip: once the card has opened and rested a moment, it plays where the artwork is
  // (through a hole in the app background, App.tsx); the artwork steps aside while it does.
  const owner = Symbol("card");
  let card: ElementNode | undefined;
  createEffect(
    on(open, o => {
      stopPreview(owner);
      if (!o || !props.preview || !previewsEnabled()) return;
      const timer = setTimeout(() => {
        const n = card?.lng as { absX?: number; absY?: number } | undefined;
        if (!n || n.absX === undefined || n.absY === undefined) return;
        startPreview(owner, props.preview!, {
          x: n.absX,
          y: n.absY,
          w: EXPAND.open,
          h: EXPAND.height,
          radius: RADIUS,
        });
      }, focus.expandDuration + CARD_PREVIEW_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  onCleanup(() => stopPreview(owner));
  const video = () => previewing(owner);
  const ease = { duration: focus.expandDuration, easing: "ease-out" } as const;
  return (
    <View
      ref={el => (root = el)}
      item={props.item}
      width={EXPAND.width}
      height={EXPAND.height + EXPAND_CAPTION_H}
      pointerX={props.shiftX}
      pointerWidth={w()}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused?.();
      }}
      onEnter={() => (props.onSelect(), true)}
    >
      <View x={props.shiftX} transition={{ x: ease }} width={EXPAND.open} height={EXPAND.height}>
        {/* The card itself grows (no clip): both images resize with it and re-crop ("cover"),
            so the edges and rounded corners stay intact the whole way. */}
        <View
          ref={el => (card = el)}
          width={w()}
          height={EXPAND.height}
          borderRadius={RADIUS}
          color={video() ? 0x00000000 : color.surface}
          transition={{ width: ease }}
        >
          <Show when={props.backdrop}>
            <View
              src={props.backdrop}
              width={w()}
              height={EXPAND.height}
              borderRadius={RADIUS}
              textureOptions={{ resizeMode: { type: "cover" } }}
              alpha={video() ? 0 : 1}
              transition={{ width: ease, alpha: { duration: 400 } }}
            />
          </Show>
          {/* The poster grows along and fades out, crossfading into the backdrop. */}
          <Artwork
            src={props.image}
            title={props.title}
            width={EXPAND.width}
            imageWidth={w()}
            height={EXPAND.height}
            radius={RADIUS}
            textureOptions={{ resizeMode: { type: "cover", clipY: 0.3 } }}
            alpha={open() ? 0 : 1}
            transition={{ width: ease, alpha: ease }}
          />
          {/* Title over the backdrop's lower edge once open. */}
          <View
            y={EXPAND.height * 0.5}
            width={w()}
            height={EXPAND.height * 0.5}
            borderRadius={RADIUS}
            colorTop={0x00000000}
            colorBottom={0x000000c0}
            alpha={open() ? 1 : 0}
            transition={{ alpha: ease, width: ease }}
          />
          <Text
            x={24}
            y={EXPAND.height - 58}
            width={EXPAND.open - 48}
            contain="width"
            maxLines={1}
            fontSize={font.heading}
            color={color.text}
            alpha={showText() && open() ? 1 : 0}
          >
            {displayText(props.title)}
          </Text>
          <Show when={(props.progress ?? 0) > 0.005}>
            <ProgressBar width={w()} y={EXPAND.height - 18} fraction={props.progress ?? 0} />
          </Show>
          <Show when={props.watched}>
            <View x={EXPAND.width - 46} y={10} width={36} height={36} borderRadius={18} color={0x000000aa}>
              <CheckMark x={9} y={10} />
            </View>
          </Show>
        </View>
        <FocusRing width={w()} height={EXPAND.height} radius={RADIUS} visible={focused()} />
        <Text
          y={EXPAND.height + 18}
          width={EXPAND.open}
          contain="width"
          maxLines={1}
          fontSize={font.caption}
          color={color.textMuted}
          alpha={showText() ? 1 : 0}
        >
          {displayText(props.meta) || " "}
        </Text>
      </View>
    </View>
  );
}
