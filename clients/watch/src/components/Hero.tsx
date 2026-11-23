// The hero at the top of Home, Movies, Shows and genre pages, as on the TV (HeroCarousel): a
// title over its backdrop with its logo, why it's featured, its facts and ratings, Play and More
// info. It moves on by itself every SLIDE_MS (or when the clip playing ends); the slide you rest on
// plays its preview clip behind the text. Swipe on touch screens; arrows and dots with a mouse.
import { t } from "@tv/i18n";
import type { TitleRating } from "@tv/api/types";
import { For, Show, createSignal, onCleanup, onSettled } from "solid-js";
import { playClip, type ClipSource } from "../clip";
import { Art, Logo } from "./cards";
import { Icon } from "./icons";
import { Ratings } from "./sections";

const SLIDE_MS = 9_000;
const CLIP_DELAY_MS = 1_500;

export interface HeroSlide {
  key: string;
  title: string;
  logo: string | null;
  backdrop: string | null;
  /** Why it's featured, already translated. */
  reason: string;
  facts: string;
  overview?: string | null;
  ratings: TitleRating[];
  clip: ClipSource;
  playLabel?: string;
  play: () => void;
  infoHref: string;
}

export function Hero(props: { slides: HeroSlide[] }) {
  const [index, setIndex] = createSignal(0);
  const hosts: HTMLElement[] = [];
  let root: HTMLElement | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let advance: ReturnType<typeof setTimeout> | undefined;
  let clip: { stop: () => void } | null = null;
  /** On screen and the page visible: only then do slides move and clips play. */
  let visible = true;

  const stop = () => {
    clearTimeout(settle);
    clearTimeout(advance);
    clip?.stop();
    clip = null;
  };
  const go = (i: number) => {
    const n = props.slides.length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    setIndex(next);
    arrive(next);
  };
  /** On slide `i`: its clip after a moment, and the next slide later (or after the clip). */
  const arrive = (i: number) => {
    stop();
    if (!visible) return;
    advance = setTimeout(() => go(i + 1), SLIDE_MS);
    settle = setTimeout(() => {
      const host = hosts[i];
      const slide = props.slides[i];
      if (!host || !slide) return;
      clip = playClip(
        host,
        slide.clip,
        () => {
          clearTimeout(advance);
          advance = setTimeout(() => go(i + 1), 1500);
        },
        () => clearTimeout(advance),
      );
    }, CLIP_DELAY_MS);
  };

  onSettled(() => {
    const io = new IntersectionObserver(
      ([e]) => {
        const now = e.isIntersecting && e.intersectionRatio > 0.4;
        if (now === visible) return;
        visible = now;
        if (visible) arrive(index());
        else stop();
      },
      { threshold: [0, 0.4, 1] },
    );
    if (root) io.observe(root);
    const onVis = () => {
      if (document.hidden) stop();
      else if (visible) arrive(index());
    };
    document.addEventListener("visibilitychange", onVis);
    arrive(0);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  });
  onCleanup(stop);

  // Swipe between slides (touch).
  let startX = 0;
  let startY = 0;
  let swiping = false;
  return (
    <section
      class="hero"
      ref={el => (root = el)}
      aria-roledescription="carousel"
      onTouchStart={e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        swiping = true;
      }}
      onTouchEnd={e => {
        if (!swiping) return;
        swiping = false;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(index() + (dx < 0 ? 1 : -1));
      }}
    >
      <For each={props.slides}>
        {(s, i) => (
          <div class={["hero-slide", { on: index() === i() }]} aria-hidden={index() !== i() ? "true" : undefined}>
            <Show when={Math.abs(i() - index()) <= 1 || (index() === props.slides.length - 1 && i() === 0)}>
              <Art image={s.backdrop} alt="" eager={i() === 0} />
            </Show>
            <div class="clip-host" ref={el => (hosts[i()] = el)} />
            <div class="scrim-left" />
            <div class="hero-content">
              <span class="hero-reason">{s.reason}</span>
              <Show when={s.logo} fallback={<h2 class="hero-title">{s.title}</h2>}>
                <Logo image={s.logo} title={s.title} />
              </Show>
              <span class="hero-facts">{s.facts}</span>
              <Ratings ratings={s.ratings} />
              <Show when={s.overview}>
                <p class="hero-overview">{s.overview}</p>
              </Show>
              <div class="hero-buttons">
                <button class="btn primary" tabindex={index() === i() ? 0 : -1} onClick={() => s.play()}>
                  <Icon name="play" size={20} />
                  {s.playLabel ?? t("Play")}
                </button>
                <a class="btn glass" tabindex={index() === i() ? 0 : -1} href={s.infoHref}>
                  <Icon name="info" size={20} />
                  {t("More info")}
                </a>
              </div>
            </div>
          </div>
        )}
      </For>
      <Show when={props.slides.length > 1}>
        <button class="icon-btn glass hero-nav prev" aria-label={t("Previous")} onClick={() => go(index() - 1)}>
          <Icon name="left" />
        </button>
        <button class="icon-btn glass hero-nav next" aria-label={t("Next")} onClick={() => go(index() + 1)}>
          <Icon name="right" />
        </button>
        <div class="hero-dots">
          <For each={props.slides}>
            {(s, i) => (
              <button
                class={["hero-dot", { on: index() === i() }]}
                aria-label={s.title}
                onClick={() => go(i())}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
