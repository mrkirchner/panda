// The building blocks of Home and the browse pages: a titled row that scrolls sideways, and the
// cards in it (posters, wide cards, genre tiles, banners).
import { imageUrl } from "@tv/api/client";
import type { Spot } from "@tv/api/types";
import { t } from "@tv/i18n";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { ContentView } from "@nativescript/core";
import { playClip, type ClipSource } from "../clip";

export function Row(props: { title: string; children: JSX.Element; action?: { text: string; tap: () => void } }) {
  return (
    <stacklayout>
      <gridlayout columns="*, auto" class="section-head">
        <label col={0} class="section-title-text" text={props.title} />
        <Show when={props.action}>
          <label col={1} class="link section-action" text={props.action!.text} on:tap={props.action!.tap} />
        </Show>
      </gridlayout>
      <scrollview orientation="horizontal" scrollBarIndicatorVisible={false}>
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

/** A genre: its name over a darkened backdrop. */
export function GenreTile(props: { name: string; image: string | null; onTap: () => void }) {
  return (
    <gridlayout class="genre-tile" on:tap={props.onTap}>
      <image class="genre-tile" src={imageUrl(props.image)} stretch="aspectFill" />
      <stacklayout class="genre-scrim" />
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
/** Rest on an opened card this long before its clip starts. */
const EXPAND_CLIP_MS = 1_000;

/**
 * A row whose open card is wide, as a focused card expands on the TV ("Recently added"): its
 * backdrop with the name and facts, and its preview clip after a moment. The first card starts
 * open; tapping another opens it; tapping the open one opens its page (OK on the TV).
 */
export function ExpandRow(props: { title: string; items: ExpandItem[] }) {
  const [open, setOpen] = createSignal(0);
  const hosts: ContentView[] = [];
  let clip: { stop: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tap = (i: number) => {
    if (open() === i) return props.items[i]?.open();
    setOpen(i);
    clip?.stop();
    clip = null;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const host = hosts[i];
      const item = props.items[i];
      if (host && item) clip = playClip(host, item.clip);
    }, EXPAND_CLIP_MS);
  };
  onCleanup(() => {
    clearTimeout(timer);
    clip?.stop();
  });
  return (
    <Row title={props.title}>
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
