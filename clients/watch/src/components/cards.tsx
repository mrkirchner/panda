// Rows and cards, as the TV's (CardRow, Card) and the phone's: posters, wide cards with progress,
// genre tiles, the spotlight banner, the expanding row of Recently Added, and ghosts while a row
// loads. Cards are links (open in a new tab, middle-click) unless they act (Continue Watching).
import { imageUrl } from "@tv/api/client";
import type { Spot } from "@tv/api/types";
import { t } from "@tv/i18n";
import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, onCleanup, onSettled } from "solid-js";
import { playClip, type ClipSource } from "../clip";
import { href, paths } from "../nav";
import { Icon } from "./icons";

/** A horizontal row with a heading; arrows page through it on wide screens with a mouse. */
export function Row(props: {
  title: string;
  children: JSX.Element;
  link?: { label: string; href: string };
  class?: string;
}) {
  let scroller: HTMLDivElement | undefined;
  const [canPrev, setCanPrev] = createSignal(false);
  const [canNext, setCanNext] = createSignal(false);
  const update = () => {
    if (!scroller) return;
    setCanPrev(scroller.scrollLeft > 4);
    setCanNext(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4);
  };
  const page = (dir: 1 | -1) =>
    scroller?.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: "smooth" });
  onSettled(() => {
    update();
    const ro = new ResizeObserver(update);
    if (scroller) ro.observe(scroller);
    return () => ro.disconnect();
  });
  return (
    <section class={["section", "row", props.class]}>
      <div class="section-head">
        <h2 class="section-title">{props.title}</h2>
        <Show when={props.link}>
          {(l) => (
            <a class="section-link" href={l().href}>
              {l().label}
            </a>
          )}
        </Show>
      </div>
      <div class="row-scroller" ref={(el) => (scroller = el)} onScroll={update}>
        {props.children}
      </div>
      <button
        class={["row-arrow", "prev", { can: canPrev() }]}
        aria-label={t("Previous")}
        onClick={() => page(-1)}
      >
        <Icon name="left" size={28} />
      </button>
      <button
        class={["row-arrow", "next", { can: canNext() }]}
        aria-label={t("Next")}
        onClick={() => page(1)}
      >
        <Icon name="right" size={28} />
      </button>
    </section>
  );
}

/** Watch progress along a card's bottom edge. */
export function Progress(props: { fraction: number }) {
  return (
    <Show when={props.fraction > 0}>
      <div class="progress">
        <i style={{ width: `${Math.min(100, Math.max(2, props.fraction * 100))}%` }} />
      </div>
    </Show>
  );
}

/** Artwork that fades in when loaded (nothing shown when there's none). */
export function Art(props: {
  image: string | null | undefined;
  class?: string;
  alt?: string;
  eager?: boolean;
}) {
  return (
    <Show when={imageUrl(props.image)}>
      {(src) => (
        <img
          class={["art", props.class]}
          src={src()}
          alt={props.alt ?? ""}
          loading={props.eager ? "eager" : "lazy"}
          decoding="async"
        />
      )}
    </Show>
  );
}

/** A poster: its title shows when there's no picture. `href` opens a page; `onClick` acts. */
export function Poster(props: {
  image: string | null | undefined;
  title: string;
  href?: string;
  onClick?: () => void;
  badge?: string;
  fraction?: number;
  watched?: boolean;
  rank?: number;
}) {
  const card = () => (
    <a
      class="card poster"
      href={props.href ?? "#"}
      title={props.title}
      onClick={(e) => {
        if (props.onClick) {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      <Show when={!props.image}>
        <span class="poster-name">{props.title}</span>
      </Show>
      <Art image={props.image} alt={props.title} />
      <Show when={props.badge}>
        <span class="badge">{props.badge}</span>
      </Show>
      <Show when={props.watched}>
        <span class="watched-mark" title={t("Watched")}>
          <Icon name="check" size={14} />
        </span>
      </Show>
      <Progress fraction={props.fraction ?? 0} />
    </a>
  );
  return (
    <Show when={props.rank} fallback={card()}>
      <div class="ranked">
        <span class="rank" aria-hidden="true">
          {props.rank}
        </span>
        {card()}
      </div>
    </Show>
  );
}

/** A wide card (Continue Watching): backdrop, title and subtitle, progress. */
export function WideCard(props: {
  image: string | null | undefined;
  title: string;
  subtitle?: string;
  fraction?: number;
  href?: string;
  onClick?: () => void;
}) {
  return (
    <a
      class="card wide"
      href={props.href ?? "#"}
      onClick={(e) => {
        if (props.onClick) {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      <Art image={props.image} alt="" />
      <div class="card-caption">
        <b>{props.title}</b>
        <Show when={props.subtitle}>
          <span>{props.subtitle}</span>
        </Show>
      </div>
      <Progress fraction={props.fraction ?? 0} />
    </a>
  );
}

/** Colors for genre tiles, by name, so a genre always looks the same (the TV's). */
const TINTS = ["#5b3a8c", "#1f5f8b", "#7a3b2e", "#2e6b4f", "#7c5a1e", "#5a2e5e", "#284a6e", "#6b2e3a"];
const tint = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
};

export function GenreTile(props: { name: string; image: string | null | undefined }) {
  return (
    <a class="card genre-tile" href={href(paths.genre(props.name))}>
      <Art image={props.image} alt="" />
      <span class="tint" style={{ background: tint(props.name) }} />
      <b>{t(props.name)}</b>
    </a>
  );
}

/** A spotlight: one title, wide, with why it's picked. */
export function Banner(props: { spot: Spot }) {
  return (
    <section class="section">
      <a class="banner" href={href(paths.spot(props.spot))}>
        <Art image={props.spot.backdrop} alt="" />
        <div class="banner-text">
          <span class="reason">{t(props.spot.reason, { title: props.spot.reason_title ?? "" })}</span>
          <b>{props.spot.title}</b>
        </div>
      </a>
    </section>
  );
}

/** A title's logo picture (TMDB/Fanart.tv), left-aligned; its name if the picture fails. */
export function Logo(props: { image: string | null | undefined; title: string; class?: string }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={imageUrl(props.image) && !failed()} fallback={<h1 class="detail-title">{props.title}</h1>}>
      <img
        class={["logo", props.class]}
        src={imageUrl(props.image)}
        alt={props.title}
        decoding="async"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

/** A row still loading: a greyed title and placeholder cards, pulsing (the TV's GhostRow). */
export function GhostRow(props: { variant?: "poster" | "wide" | "genre" | "expand" }) {
  const v = () => props.variant ?? "poster";
  const size = () =>
    v() === "wide"
      ? { width: "var(--wide-w)", "aspect-ratio": "16 / 9" }
      : v() === "genre"
        ? { width: "var(--genre-w)", "aspect-ratio": "16 / 9" }
        : v() === "expand"
          ? { width: "calc(var(--expand-h) * 2 / 3)", height: "var(--expand-h)" }
          : { width: "var(--poster-w)", "aspect-ratio": "2 / 3" };
  return (
    <section class="section" aria-hidden="true">
      <div class="section-head">
        <div class="ghost ghost-title" />
      </div>
      <div class="row-scroller" style={{ overflow: "hidden" }}>
        <Show when={v() === "expand"}>
          <div
            class="ghost"
            style={{ width: "calc(var(--expand-h) * 16 / 9)", height: "var(--expand-h)", flex: "none" }}
          />
        </Show>
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
          {() => <div class="ghost" style={{ ...size(), flex: "none" }} />}
        </For>
      </div>
    </section>
  );
}

export function GhostHero() {
  return <div class="ghost ghost-hero" aria-hidden="true" />;
}

/** One card of an expanding row. */
export interface ExpandItem {
  key: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  meta: string;
  clip: ClipSource;
  fraction?: number;
  href: string;
}

/** Rest on an open card this long before its clip plays. */
const EXPAND_CLIP_MS = 1000;
/** With a mouse, a card opens once the pointer rests on it this long (crossing doesn't). */
const HOVER_OPEN_MS = 220;

/**
 * The TV's Recently Added row: one card open at a time, showing its backdrop, name and facts (and
 * its clip after a moment); the rest are posters. With a mouse, resting on a card opens it; on a
 * touch screen, the first tap opens a card and the second opens its page; keyboard focus opens it.
 */
export function ExpandRow(props: {
  title: string;
  items: ExpandItem[];
  link?: { label: string; href: string };
}) {
  const [open, setOpen] = createSignal(0);
  /** Each card's clip spot, by its title (cards are matched by key across reloads). */
  const hosts = new Map<string, HTMLElement>();
  let clip: { stop: () => void } | null = null;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const hoverable = matchMedia("(hover: hover)").matches;

  const openAt = (i: number) => {
    if (i === open()) return;
    setOpen(i);
    clip?.stop();
    clip = null;
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => {
      const item = props.items[i];
      const host = item && hosts.get(item.key);
      if (host && item) clip = playClip(host, item.clip);
    }, EXPAND_CLIP_MS);
  };
  onCleanup(() => {
    clearTimeout(clipTimer);
    clearTimeout(hoverTimer);
    clip?.stop();
  });

  return (
    <Row title={props.title} class="expand-row" link={props.link}>
      <For each={props.items} keyed={(x: ExpandItem) => x.key}>
        {(item, i) => (
          <a
            class={["expand-card", { open: open() === i() }]}
            href={item().href}
            aria-label={item().title}
            onMouseEnter={() => {
              if (!hoverable) return;
              clearTimeout(hoverTimer);
              hoverTimer = setTimeout(() => openAt(i()), HOVER_OPEN_MS);
            }}
            onMouseLeave={() => clearTimeout(hoverTimer)}
            onFocus={() => openAt(i())}
            onClick={(e) => {
              // Touch: the first tap opens the card, the next opens its page.
              if (!hoverable && open() !== i()) {
                e.preventDefault();
                openAt(i());
                e.currentTarget.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
              }
            }}
          >
            <div class="layer poster-layer">
              <Art image={item().poster} alt="" />
            </div>
            <div class="layer wide-layer">
              <Show when={Math.abs(i() - open()) <= 1}>
                <Art image={item().backdrop ?? item().poster} alt="" />
              </Show>
              <div class="clip-host layer" ref={(el) => hosts.set(item().key, el)} />
              <div class="card-caption">
                <b>{item().title}</b>
                <span>{item().meta}</span>
              </div>
            </div>
            <Progress fraction={item().fraction ?? 0} />
          </a>
        )}
      </For>
    </Row>
  );
}

/** A detail page's backdrop, with its clip playing over it after a moment. */
export function DetailArt(props: { image: string | null | undefined; clip?: ClipSource }) {
  let host: HTMLDivElement | undefined;
  let clip: { stop: () => void } | null = null;
  onSettled(() => {
    const timer = setTimeout(() => {
      if (host && props.clip) clip = playClip(host, props.clip);
    }, 1500);
    return () => {
      clearTimeout(timer);
      clip?.stop();
    };
  });
  return (
    <>
      <Art image={props.image} alt="" eager />
      <div class="clip-host" ref={(el) => (host = el)} />
      <div class="scrim-left" />
    </>
  );
}
