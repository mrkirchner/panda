// The hero carousel at the top of Home, Movies and Shows, as on the TV (HeroCarousel): a title
// over its backdrop with its logo, why it's featured, its facts and ratings, Play and More info.
// Swiped like pages; it moves on by itself every SLIDE_MS (or when the clip playing ends), and
// the slide you rest on plays its preview clip behind the text.
import { Screen, type ContentView, type ScrollView } from "@nativescript/core";
import { imageUrl } from "@tv/api/client";
import type { TitleRating } from "@tv/api/types";
import { t } from "@tv/i18n";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { playClip, type ClipSource } from "../clip";
import { Ratings } from "./sections";
import { Logo } from "./cards";

/** The TV's slide time. */
const SLIDE_MS = 9_000;
/** Rest on a slide this long before its clip starts. */
const CLIP_DELAY_MS = 1_500;

export interface HeroSlide {
  key: string;
  title: string;
  logo: string | null;
  backdrop: string | null;
  /** Why it's featured ("Recently added"), already translated. */
  reason: string;
  facts: string;
  ratings: TitleRating[];
  clip: ClipSource;
  playLabel?: string;
  play: () => void;
  info: () => void;
}

export function Hero(props: { slides: HeroSlide[] }) {
  const width = Screen.mainScreen.widthDIPs;
  const height = Math.round(width * 1.3);
  const [index, setIndex] = createSignal(0);
  const hosts: ContentView[] = [];
  let scroller: ScrollView | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let advance: ReturnType<typeof setTimeout> | undefined;
  /** This hero's clip (only ever its own is stopped). */
  let clip: { stop: () => void } | null = null;

  const next = () => {
    const n = props.slides.length;
    if (n < 2 || !scroller?.isLoaded) return;
    scroller.scrollToHorizontalOffset(((index() + 1) % n) * width, true);
  };
  /** On slide `i`: its clip after a moment, and the next slide later (or after the clip). */
  const arrive = (i: number) => {
    clearTimeout(settle);
    clearTimeout(advance);
    advance = setTimeout(next, SLIDE_MS);
    settle = setTimeout(() => {
      const host = hosts[i];
      const slide = props.slides[i];
      if (!host || !slide) return;
      clip?.stop();
      clip = playClip(
        host,
        slide.clip,
        () => {
          clearTimeout(advance);
          advance = setTimeout(next, 1500);
        },
        // While a clip plays, the slide stays until it ends.
        () => clearTimeout(advance),
      );
    }, CLIP_DELAY_MS);
  };
  setTimeout(() => arrive(0), 0);
  onCleanup(() => {
    clearTimeout(settle);
    clearTimeout(advance);
    clip?.stop();
  });

  return (
    <gridlayout height={height + 28} rows="*, 28">
      <scrollview
        row={0}
        orientation="horizontal"
        scrollBarIndicatorVisible={false}
        ref={(el: ScrollView) => (scroller = el)}
        on:loaded={(e: { object: ScrollView }) => {
          (e.object.ios as UIScrollView).pagingEnabled = true;
        }}
        on:scroll={(e: { scrollX: number }) => {
          const i = Math.round(e.scrollX / width);
          if (i !== index() && i >= 0 && i < props.slides.length) {
            setIndex(i);
            clip?.stop();
            clip = null;
            arrive(i);
          }
        }}
      >
        <stacklayout orientation="horizontal">
          <For each={props.slides}>
            {(s, i) => (
              <gridlayout width={width} height={height}>
                <image width={width} height={height} src={imageUrl(s.backdrop)} stretch="aspectFill" />
                <contentview ref={(el: ContentView) => (hosts[i()] = el)} class="clip-host" />
                <stacklayout class="hero-scrim" />
                <stacklayout class="hero-content" verticalAlignment="bottom">
                  <label class="hero-reason" text={s.reason} />
                  <Show when={s.logo} fallback={<label class="hero-title" textWrap={true} text={s.title} />}>
                    <Logo class="hero-logo" image={s.logo} height={84} maxWidth={width * 0.7} />
                  </Show>
                  <label class="hero-facts" textWrap={true} text={s.facts} />
                  <Ratings ratings={s.ratings} />
                  <gridlayout columns="*, *" rows="auto" class="hero-buttons">
                    <button col={0} class="primary hero-button" text={s.playLabel ?? t("Play")} on:tap={s.play} />
                    <button col={1} class="secondary hero-button" text={t("More info")} on:tap={s.info} />
                  </gridlayout>
                </stacklayout>
              </gridlayout>
            )}
          </For>
        </stacklayout>
      </scrollview>
      <stacklayout row={1} orientation="horizontal" horizontalAlignment="center">
        <For each={props.slides}>
          {(_, i) => <label class={i() === index() ? "dot on" : "dot"} text="●" />}
        </For>
      </stacklayout>
    </gridlayout>
  );
}
