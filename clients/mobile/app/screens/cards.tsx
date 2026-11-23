// The building blocks of Home and the browse pages: a titled row that scrolls sideways, and the
// cards in it (posters, wide cards, genre tiles, banners).
import { imageUrl } from "@tv/api/client";
import type { Spot } from "@tv/api/types";
import { t } from "@tv/i18n";
import { genreTint } from "@tv/theme";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { For, Show, createSignal, flush, onCleanup } from "solid-js";
import type { ContentView, ScrollView } from "@nativescript/core";
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
/** A poster's width, the gap between cards, and the row's side padding (app.css). */
const POSTER_W = 112;
const CARD_GAP = 10;
const ROW_PAD = 16;
/** Rest on an opened card this long before its clip starts. */
const EXPAND_CLIP_MS = 1_000;

/**
 * A row whose open card is wide, as a focused card expands on the TV ("Recently added"): its
 * backdrop with the name and facts, and its preview clip after a moment. The first card starts
 * open; tapping another opens it at once; tapping the open one opens its page (OK on the TV).
 */
export function ExpandRow(props: { title: string; items: ExpandItem[] }) {
  const [open, setOpen] = createSignal(0);
  const hosts: ContentView[] = [];
  let scroller: ScrollView | undefined;
  let clip: { stop: () => void } | null = null;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;

  /** Where card `i` starts in the row, with card `opened` wide. */
  const leftOf = (i: number, opened: number) =>
    ROW_PAD + i * (POSTER_W + CARD_GAP) + (i > opened ? EXPANDED_W - POSTER_W : 0);
  /** Card `i` (now wide) cut off at either side: scroll just enough to show it, nothing more. */
  const reveal = (i: number) => {
    const sv = scroller;
    if (!sv) return;
    const left = leftOf(i, i) - ROW_PAD;
    const right = leftOf(i, i) + EXPANDED_W + ROW_PAD;
    const x = sv.horizontalOffset;
    const view = sv.getActualSize().width;
    if (left < x) sv.scrollToHorizontalOffset(Math.max(0, left), true);
    else if (right > x + view) sv.scrollToHorizontalOffset(Math.min(sv.scrollableWidth, right - view), true);
  };
  /** A tap: open that card at once (its neighbours slide over), or the open one's page (OK on
   * the TV). Scrolling doesn't open cards: a row changing shape under your finger feels wrong. */
  const tap = (i: number) => {
    if (open() === i) return props.items[i]?.open();
    const row = scroller?.ios as UIScrollView | undefined;
    UIView.animateWithDurationAnimations(0.25, () => {
      setOpen(i);
      flush();
      row?.layoutIfNeeded();
    });
    reveal(i);
    clip?.stop();
    clip = null;
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => {
      const host = hosts[i];
      const item = props.items[i];
      if (host && item && open() === i) clip = playClip(host, item.clip);
    }, EXPAND_CLIP_MS);
  };
  devExpand ??= tap;
  devScrollRow ??= (x: number) => scroller?.scrollToHorizontalOffset(x, true);
  onCleanup(() => {
    clearTimeout(clipTimer);
    clip?.stop();
    if (devExpand === tap) devExpand = null;
  });
  return (
    <Row title={props.title} scrollRef={el => (scroller = el)}>
      <For each={props.items}>
        {(item, i) => (
          <Show
            when={open() === i()}
            fallback={
              <Poster image={item.poster} title={item.title} fraction={item.fraction} onTap={() => tap(i())} />
            }
          >
            <gridlayout class="expanded" width={EXPANDED_W} on:tap={() => tap(i())}>
              <image class="expanded-art" src={imageUrl(item.backdrop ?? item.poster)} stretch="aspectFill" />
              <contentview class="clip-host expanded-art" ref={(el: ContentView) => (hosts[i()] = el)} />
              <stacklayout class="expanded-scrim" />
              <stacklayout class="expanded-text" verticalAlignment="bottom">
                <label class="expanded-title" textWrap={true} maxLines={2} text={item.title} />
                <label class="expanded-meta" text={item.meta} />
              </stacklayout>
            </gridlayout>
          </Show>
        )}
      </For>
    </Row>
  );
}

/** Debug builds (devLaunch `-pandaExpand <n>`): open card n of the first expanding row, as a tap. */
export let devExpand: ((i: number) => void) | null = null;
/** Debug builds (`-pandaRowScroll <x>`): scroll the first expanding row as a finger would. */
export let devScrollRow: ((x: number) => void) | null = null;
