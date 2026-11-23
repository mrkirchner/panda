// The building blocks of Home and the browse pages: a titled row that scrolls sideways, and the
// cards in it (posters, wide cards, genre tiles, banners).
import { imageUrl } from "@tv/api/client";
import type { Spot } from "@tv/api/types";
import { t } from "@tv/i18n";
import { genreTint } from "@tv/theme";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Screen, type ContentView, type ScrollView, type View } from "@nativescript/core";
import { platform } from "../platform";
import type { ClipSource } from "../platformTypes";

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
        <image loadMode="async" class="poster" src={imageUrl(props.image)} stretch="aspectFill" />
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
      <image loadMode="async" class="wide" src={imageUrl(props.image)} stretch="aspectFill" />
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
      <image loadMode="async" class="spot" src={imageUrl(props.spot.backdrop)} stretch="aspectFill" />
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
      <image loadMode="async" class="genre-tile" src={imageUrl(props.image)} stretch="aspectFill" />
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
      <image loadMode="async" class="banner-image" src={imageUrl(props.spot.backdrop)} stretch="aspectFill" />
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
    if (host) clip = platform.clips.play(host, props.clip, undefined, undefined, props.inSheet ?? false);
  }, CLIP_DELAY_MS);
  onCleanup(() => {
    clearTimeout(timer);
    clip?.stop();
  });
  return (
    <gridlayout class="hero">
      <image loadMode="async" class="hero" src={imageUrl(props.image)} stretch="aspectFill" />
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
    <image loadMode="async"
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
const MOVE_MS = 320;

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

  /** How open card `j` is (0 poster, 1 open) with the spot at `at` (fractional while dragging). */
  const openness = (j: number, at: number) => Math.max(0, 1 - Math.abs(j - at));
  const widthOf = (j: number, at: number) => POSTER_W + (EXPANDED_W - POSTER_W) * openness(j, at);
  /**
   * Every card's place and size with the spot at `at`: whole numbers at rest, fractions while a
   * finger drags, so the open card closes and the next opens as you swipe. The row is cut off at
   * the page margin (`.focus-row`), so cards leave there.
   */
  const layout = (at: number) => {
    const base = Math.max(0, Math.min(cards.length - 1, Math.floor(at)));
    // Distance from card 0's start to the spot: whole cards before `base`, then part of `base`.
    let offset = 0;
    for (let i = 0; i < base; i++) offset += widthOf(i, at) + CARD_GAP;
    offset += (at - base) * (widthOf(base, at) + CARD_GAP);
    const out: { x: number; w: number; open: number }[] = [];
    let x = -offset;
    for (let j = 0; j < cards.length; j++) {
      const w = widthOf(j, at);
      // Poster or backdrop, switched quickly around the halfway point: both at once (a zoomed
      // poster over the backdrop and its caption) read as a jumble.
      out.push({ x, w, open: Math.min(1, Math.max(0, (openness(j, at) - 0.35) / 0.3)) });
      x += w + CARD_GAP;
    }
    return out;
  };
  /** Where the spot is now (fractional mid-drag or mid-settle). */
  let current = 0;
  let settling: ReturnType<typeof setInterval> | undefined;
  /** Lay the cards out with the spot at `at`. */
  const show = (at: number) => {
    current = at;
    const spots = layout(at);
    for (let j = 0; j < cards.length; j++) {
      const card = cards[j];
      if (!card) continue;
      const { x, w, open } = spots[j];
      card.translateX = x;
      card.width = w;
      if (posters[j]) posters[j].opacity = 1 - open;
      if (wides[j]) wides[j].opacity = open;
    }
  };
  /**
   * Settle to `at` frame by frame with the same layout the drag uses (ease-out, no overshoot).
   * NativeScript's own width animation grew cards about their centre and fought the position
   * animation, so the open card wobbled.
   */
  const place = (at: number, animate = true) => {
    clearInterval(settling);
    if (!animate) return show(at);
    const from = current;
    const started = Date.now();
    settling = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / MOVE_MS);
      show(from + (at - from) * (1 - (1 - t) ** 3));
      if (t >= 1) clearInterval(settling);
    }, 1000 / 60);
  };
  /** Bring card `n` to the spot (and its clip after a moment). */
  const goTo = (n: number) => {
    const next = Math.max(0, Math.min(props.items.length - 1, n));
    const changed = next !== focus;
    focus = next;
    setNear(next);
    place(next, true);
    if (!changed) return;
    clip?.stop();
    clip = null;
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => {
      const host = hosts[next];
      const item = props.items[next];
      if (host && item && focus === next) clip = platform.clips.play(host, item.clip);
    }, EXPAND_CLIP_MS);
  };
  const tap = (i: number) => (i === focus ? props.items[i]?.open() : goTo(i));

  /** The finger moved `tx` from where it started: the spot follows a card per poster-width,
   * resisting past either end. */
  const drag = (tx: number) => {
    let at = focus - tx / STEP;
    const last = props.items.length - 1;
    if (at < 0) at = at / 3;
    else if (at > last) at = last + (at - last) / 3;
    place(at, false);
  };
  /** Let go after `tx` at `vx` points/s: settle a card per poster-width swiped (a flick more). */
  const release = (tx: number, vx: number) => goTo(focus - Math.round((tx + vx * 0.2) / STEP));
  /** The sideways swipe (sideways.*.ts: a pan recognizer on iOS, a touch listener on Android),
   * attached once: the row loads again on every tab switch and Back. */
  let detachSwipe: (() => void) | null = null;
  const attachPan = (row: View) => {
    if (detachSwipe) return;
    detachSwipe = platform.gestures.sideways(row, {
      began: () => clearInterval(settling),
      moved: drag,
      released: release,
    });
  };
  /** Backdrops only near the spot (each is a 1280 px picture): the open card and its neighbours. */
  const [near, setNear] = createSignal(0);

  devExpand ??= tap;
  devScrollRow ??= (steps: number) => goTo(focus + steps);
  // A finger, for checking the feel: drags `distance` points over `ms`, 60 updates a second, then
  // lets go at the speed it was moving.
  devDrag ??= (distance: number, ms: number) => {
    const frames = Math.max(1, Math.round((ms / 1000) * 60));
    let n = 0;
    const timer = setInterval(() => {
      n++;
      const t = n / frames;
      // Ease in-out, like a thumb.
      const tx = distance * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      drag(tx);
      if (n >= frames) {
        clearInterval(timer);
        release(tx, (distance / ms) * 1000 * 0.6);
      }
    }, 1000 / 60);
  };
  onCleanup(() => {
    clearTimeout(clipTimer);
    clearInterval(settling);
    clip?.stop();
    detachSwipe?.();
    detachSwipe = null;
    if (devExpand === tap) devExpand = null;
  });

  return (
    <stacklayout>
      <label class="section-title" text={props.title} />
      <absolutelayout
        class="focus-row"
        clipToBounds={true}
        height={CARD_H}
        on:loaded={(e: { object: View }) => {
          attachPan(e.object);
          place(focus, false);
        }}
      >
        <For each={props.items}>
          {(item, i) => (
            <gridlayout
              class="focus-card"
              width={i() === 0 ? EXPANDED_W : POSTER_W}
              height={CARD_H}
              translateX={i() === 0 ? 0 : EXPANDED_W + CARD_GAP + (i() - 1) * STEP}
              ref={(el: View) => (cards[i()] = el)}
              on:tap={() => tap(i())}
            >
              <gridlayout opacity={i() === 0 ? 1 : 0} ref={(el: View) => (wides[i()] = el)}>
                <image
                  loadMode="async"
                  class="expanded-art"
                  src={Math.abs(i() - near()) <= 1 ? imageUrl(item.backdrop ?? item.poster) : undefined}
                  stretch="aspectFill"
                />
                <contentview class="clip-host expanded-art" ref={(el: ContentView) => (hosts[i()] = el)} />
                <stacklayout class="expanded-scrim" />
                <stacklayout class="expanded-text" verticalAlignment="bottom">
                  <label class="expanded-title" textWrap={true} maxLines={2} text={item.title} />
                  <label class="expanded-meta" text={item.meta} />
                </stacklayout>
              </gridlayout>
              <gridlayout opacity={i() === 0 ? 0 : 1} ref={(el: View) => (posters[i()] = el)} rows="*, auto">
                <image loadMode="async" rowSpan={2} class="poster" src={imageUrl(item.poster)} stretch="aspectFill" />
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
/** Debug builds (`-pandaDrag <points>`): drag the first expanding row like a finger. */
export let devDrag: ((distance: number, ms: number) => void) | null = null;

/**
 * A row still loading, as the TV's GhostRow: a greyed title and placeholder tiles, gently
 * pulsing, holding the row's place so the page doesn't jump when it arrives.
 */
export function GhostRow(props: { variant?: "poster" | "wide" | "genre" | "expand" }) {
  const v = props.variant ?? "poster";
  const tile = v === "wide" ? "ghost ghost-wide" : v === "genre" ? "ghost ghost-genre" : "ghost ghost-poster";
  return (
    <stacklayout class="ghost-row">
      <stacklayout class="ghost ghost-title" />
      <stacklayout orientation="horizontal" class="row-items">
        <Show when={v === "expand"}>
          <stacklayout class="ghost ghost-expand" />
        </Show>
        <For each={[0, 1, 2, 3]}>{() => <stacklayout class={tile} />}</For>
      </stacklayout>
    </stacklayout>
  );
}

/** The hero still loading: its shape, pulsing. */
export function GhostHero() {
  const width = Screen.mainScreen.widthDIPs;
  return (
    <stacklayout class="ghost-row">
      <stacklayout class="ghost" width={width} height={Math.round(width * 1.3) + 28} />
    </stacklayout>
  );
}
