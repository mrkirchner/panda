// The building blocks of Home and the browse pages: a titled row that scrolls sideways, and the
// cards in it (posters, wide cards, genre tiles, banners).
import { imageUrl } from "@tv/api/client";
import type { Spot } from "@tv/api/types";
import { t } from "@tv/i18n";
import { genreTint } from "@tv/theme";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { ContentView, ScrollView, View } from "@nativescript/core";
import { playClip, type ClipSource } from "../clip";

export function Row(props: {
  title: string;
  children: JSX.Element;
  action?: { text: string; tap: () => void };
  /** The row's scroller (to bring a card into view). */
  scrollRef?: (sv: ScrollView) => void;
}) {
  return (
    <stacklayout>
      <gridlayout columns="*, auto" class="section-head">
        <label col={0} class="section-title-text" text={props.title} />
        <Show when={props.action}>
          <label col={1} class="link section-action" text={props.action!.text} on:tap={props.action!.tap} />
        </Show>
      </gridlayout>
      <scrollview orientation="horizontal" scrollBarIndicatorVisible={false} ref={(el: ScrollView) => props.scrollRef?.(el)}>
        <stacklayout orientation="horizontal" class="row-items">
          {props.children}
        </stacklayout>
      </scrollview>
    </stacklayout>
  );
}

export function Poster(props: {
  image: string | null;
  title: string;
  rank?: number;
  fraction?: number;
  /** "Requested", "Downloading 42%"... over the corner. */
  badge?: string;
  /** Watched all the way: a check in the corner (as the TV's tiles). */
  watched?: boolean;
  onTap: () => void;
}) {
  return (
    <gridlayout class="poster-cell" rows="auto, auto" on:tap={props.onTap}>
      <gridlayout row={0} class="poster">
        <Show when={!props.image}>
          <label class="small center poster-name" textWrap={true} text={props.title} />
        </Show>
        <image class="poster" src={imageUrl(props.image)} stretch="aspectFill" />
        <Show when={props.rank}>
          <label class="rank" text={String(props.rank)} />
        </Show>
        <Show when={props.badge}>
          <label class="badge" text={props.badge ?? ""} />
        </Show>
        <Show when={props.watched}>
          <label class="watched-mark" text="✓" />
        </Show>
      </gridlayout>
      <Show when={(props.fraction ?? 0) > 0}>
        <Progress row={1} fraction={props.fraction!} width={112} />
      </Show>
    </gridlayout>
  );
}

export function Progress(props: { fraction: number; width: number; row?: number }) {
  return (
    <gridlayout
      row={props.row ?? 0}
      class="progress-track"
      width={props.width}
      columns={`${Math.max(props.fraction, 0.01)}*, ${Math.max(1 - props.fraction, 0.01)}*`}
    >
      <stacklayout class="progress-fill" col={0} />
    </gridlayout>
  );
}

export function WideCard(props: {
  image: string | null;
  title: string;
  subtitle?: string;
  fraction?: number;
  onTap: () => void;
}) {
  return (
    <stacklayout class="wide-cell" on:tap={props.onTap}>
      <image class="wide" src={imageUrl(props.image)} stretch="aspectFill" />
      <Show when={(props.fraction ?? 0) > 0}>
        <Progress fraction={props.fraction!} width={240} />
      </Show>
      <label class="card-label" text={props.title} />
      <Show when={props.subtitle}>
        <label class="small card-sub" text={props.subtitle ?? ""} />
      </Show>
    </stacklayout>
  );
}

/** A featured title as a wide card: its backdrop, why it's here, its name. */
export function SpotCard(props: { spot: Spot; onTap: () => void }) {
  return (
    <stacklayout class="spot-cell" on:tap={props.onTap}>
      <image class="spot" src={imageUrl(props.spot.backdrop)} stretch="aspectFill" />
      <label class="small accent mt8" text={reason(props.spot)} />
      <label class="h2" textWrap={true} text={props.spot.title} />
    </stacklayout>
  );
}

/** "Because you watched Alien" etc. (the server's English, translated). */
export const reason = (s: Spot) => t(s.reason, { title: s.reason_title ?? "" });

/** A genre's tint (the TV's `genreTint`, 0xRRGGBBAA) as CSS, at `alpha` (0-255). */
export const tintCss = (genre: string, alpha: number) =>
  `#${(genreTint(genre) >>> 8).toString(16).padStart(6, "0")}${alpha.toString(16).padStart(2, "0")}`;

/** A genre: its name over its backdrop, washed in the genre's color (as on the TV). */
export function GenreTile(props: { name: string; image: string | null; onTap: () => void }) {
  return (
    <gridlayout class="genre-tile" on:tap={props.onTap}>
      <image class="genre-tile" src={imageUrl(props.image)} stretch="aspectFill" />
      <stacklayout class="genre-scrim" />
      <stacklayout class="genre-wash" backgroundColor={tintCss(props.name, 0x66)} />
      <label class="genre-name" text={t(props.name)} />
    </gridlayout>
  );
}

/** A full-width spotlight between rows. */
export function Banner(props: { spot: Spot; onTap: () => void }) {
  return (
    <stacklayout class="banner" on:tap={props.onTap}>
      <image class="banner-image" src={imageUrl(props.spot.backdrop)} stretch="aspectFill" />
      <label class="small accent mt8" text={reason(props.spot)} />
      <label class="h2" textWrap={true} text={props.spot.title} />
    </stacklayout>
  );
}

/** A page's backdrop, with its preview clip fading in over it after a moment (as on the TV). */
export function ClipArt(props: { image: string | null | undefined; clip: ClipSource; inSheet?: boolean }) {
  let host: ContentView | undefined;
  let clip: { stop: () => void } | null = null;
  const timer = setTimeout(() => {
    if (host) clip = playClip(host, props.clip, undefined, undefined, props.inSheet ?? false);
  }, CLIP_DELAY_MS);
  onCleanup(() => {
    clearTimeout(timer);
    clip?.stop();
  });
  return (
    <gridlayout class="hero">
      <image class="hero" src={imageUrl(props.image)} stretch="aspectFill" />
      <contentview class="clip-host" ref={(el: ContentView) => (host = el)} />
    </gridlayout>
  );
}

/** Rest on a page this long before its clip starts. */
const CLIP_DELAY_MS = 1_500;

/**
 * A title's logo, left-aligned at `height`: iOS centers a picture inside its box, so the box takes
 * the logo's own shape once it's loaded (no wider than `maxWidth`).
 */
export function Logo(props: { image: string | null | undefined; height: number; maxWidth: number; class?: string }) {
  return (
    <image
      class={props.class ?? "logo"}
      src={imageUrl(props.image)}
      height={props.height}
      width={props.maxWidth}
      horizontalAlignment="left"
      stretch="aspectFit"
      // NativeScript announces a loaded picture as `imageSourceChange` (a property's "<name>Change").
      on:imageSourceChange={(e: { value: { width: number; height: number } | null; object: { width: number } }) => {
        if (!e.value?.width || !e.value.height) return;
        e.object.width = Math.min(props.maxWidth, (props.height * e.value.width) / e.value.height);
      }}
    />
  );
}

/** One card of an expanding row. */
export interface ExpandItem {
  key: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  /** "2009 · 1h 37m · Science Fiction". */
  meta: string;
  clip: ClipSource;
  fraction?: number;
  open: () => void;
}

/** Posters and the open card: the TV's 240x360 that opens to 640 wide, at phone size. */
const EXPANDED_W = 300;
const CARD_H = 168;
/** A poster's width, the gap between cards, and the row's side padding (app.css). */
const POSTER_W = 112;
const CARD_GAP = 10;
const ROW_PAD = 16;
/** One poster's step along the row. */
const STEP = POSTER_W + CARD_GAP;
/** Rest on an opened card this long before its clip starts. */
const EXPAND_CLIP_MS = 1_000;
const MOVE_MS = 260;

type PanState = { translationX: number; velocityX: number; state: number };

/** Lets the page scroll vertically: the row's pan only starts on a mostly sideways swipe. */
const Sideways = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject };
}).extend(
  {
    gestureRecognizerShouldBegin(g: UIPanGestureRecognizer) {
      const v = g.velocityInView(g.view);
      return Math.abs(v.x) > Math.abs(v.y);
    },
  },
  { protocols: [UIGestureRecognizerDelegate] },
);
const PanTarget = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject & { fn?: (g: UIPanGestureRecognizer) => void } };
}).extend(
  {
    pan(this: { fn?: (g: UIPanGestureRecognizer) => void }, g: UIPanGestureRecognizer) {
      this.fn?.(g);
    },
  },
  { exposedMethods: { pan: { returns: interop.types.void, params: [UIPanGestureRecognizer] } } },
);

/**
 * A row with a fixed focus spot at its left, as a TV row's focus (the TV's "Recently added"):
 * the card in the spot is open (its backdrop, name and facts, and its preview clip after a
 * moment), the rest are posters after it. Swiping moves the titles through the spot: the open
 * one closes as it leaves, the next opens as it arrives. A tap on a poster brings it to the
 * spot; a tap on the open card opens its page (OK on the TV).
 */
export function ExpandRow(props: { title: string; items: ExpandItem[] }) {
  let focus = 0;
  const cards: View[] = [];
  const posters: View[] = [];
  const wides: View[] = [];
  const hosts: ContentView[] = [];
  let clip: { stop: () => void } | null = null;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;

  /** Where card `j` sits with card `f` in the spot. */
  const xOf = (j: number, f: number) =>
    // Cards past the spot wait fully off the left edge (no sliver showing).
    j < f ? -ROW_PAD - (f - j) * STEP : j === f ? ROW_PAD : ROW_PAD + EXPANDED_W + CARD_GAP + (j - f - 1) * STEP;
  /** Lay every card out for focus `f` (animated, or at once while dragging). */
  const place = (f: number, drag = 0, animate = true) => {
    for (let j = 0; j < cards.length; j++) {
      const card = cards[j];
      if (!card) continue;
      const x = xOf(j, f) + drag;
      const open = j === f;
      if (!animate) {
        card.translateX = x;
        continue;
      }
      void card.animate({ translate: { x, y: 0 }, width: open ? EXPANDED_W : POSTER_W, duration: MOVE_MS, curve: "easeOut" });
      void posters[j]?.animate({ opacity: open ? 0 : 1, duration: MOVE_MS });
      void wides[j]?.animate({ opacity: open ? 1 : 0, duration: MOVE_MS });
    }
  };
  /** Bring card `n` to the spot (and its clip after a moment). */
  const goTo = (n: number) => {
    const next = Math.max(0, Math.min(props.items.length - 1, n));
    const changed = next !== focus;
    focus = next;
    place(next);
    if (!changed) return;
    clip?.stop();
    clip = null;
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => {
      const host = hosts[next];
      const item = props.items[next];
      if (host && item && focus === next) clip = playClip(host, item.clip);
    }, EXPAND_CLIP_MS);
  };
  const tap = (i: number) => (i === focus ? props.items[i]?.open() : goTo(i));

  /** The finger: the row follows it, then settles a card per poster-width swiped (a flick more). */
  const onPan = (g: UIPanGestureRecognizer) => {
    const tx = g.translationInView(g.view).x;
    if (g.state === UIGestureRecognizerState.Changed) {
      // Resisting past either end.
      const atEnd = (focus === 0 && tx > 0) || (focus === props.items.length - 1 && tx < 0);
      place(focus, atEnd ? tx / 3 : tx, false);
    } else if (g.state === UIGestureRecognizerState.Ended || g.state === UIGestureRecognizerState.Cancelled) {
      const projected = tx + g.velocityInView(g.view).x * 0.2;
      goTo(focus - Math.round(projected / STEP));
    }
  };
  const attachPan = (row: View) => {
    const native = row.ios as UIView | undefined;
    if (!native) return;
    const target = new PanTarget();
    target.fn = onPan;
    const pan = UIPanGestureRecognizer.alloc().initWithTargetAction(target, "pan");
    const delegate = new Sideways();
    pan.delegate = delegate as unknown as UIGestureRecognizerDelegate;
    native.addGestureRecognizer(pan);
    keep.push(target, delegate);
  };
  const keep: NSObject[] = [];

  devExpand ??= tap;
  devScrollRow ??= (steps: number) => goTo(focus + steps);
  onCleanup(() => {
    clearTimeout(clipTimer);
    clip?.stop();
    keep.length = 0;
    if (devExpand === tap) devExpand = null;
  });

  return (
    <stacklayout>
      <label class="section-title" text={props.title} />
      <absolutelayout
        class="focus-row"
        height={CARD_H}
        on:loaded={(e: { object: View }) => {
          attachPan(e.object);
          place(focus, 0, false);
        }}
      >
        <For each={props.items}>
          {(item, i) => (
            <gridlayout
              class="focus-card"
              width={i() === 0 ? EXPANDED_W : POSTER_W}
              height={CARD_H}
              translateX={xOf(i(), 0)}
              ref={(el: View) => (cards[i()] = el)}
              on:tap={() => tap(i())}
            >
              <gridlayout opacity={i() === 0 ? 1 : 0} ref={(el: View) => (wides[i()] = el)}>
                <image class="expanded-art" src={imageUrl(item.backdrop ?? item.poster)} stretch="aspectFill" />
                <contentview class="clip-host expanded-art" ref={(el: ContentView) => (hosts[i()] = el)} />
                <stacklayout class="expanded-scrim" />
                <stacklayout class="expanded-text" verticalAlignment="bottom">
                  <label class="expanded-title" textWrap={true} maxLines={2} text={item.title} />
                  <label class="expanded-meta" text={item.meta} />
                </stacklayout>
              </gridlayout>
              <gridlayout opacity={i() === 0 ? 0 : 1} ref={(el: View) => (posters[i()] = el)} rows="*, auto">
                <image rowSpan={2} class="poster" src={imageUrl(item.poster)} stretch="aspectFill" />
                <Show when={(item.fraction ?? 0) > 0}>
                  <Progress row={1} fraction={item.fraction!} width={POSTER_W} />
                </Show>
              </gridlayout>
            </gridlayout>
          )}
        </For>
      </absolutelayout>
    </stacklayout>
  );
}

/** Debug builds (devLaunch `-pandaExpand <n>`): open card n of the first expanding row, as a tap. */
export let devExpand: ((i: number) => void) | null = null;
/** Debug builds (`-pandaRowScroll <n>`): swipe the first expanding row n cards along. */
export let devScrollRow: ((steps: number) => void) | null = null;
