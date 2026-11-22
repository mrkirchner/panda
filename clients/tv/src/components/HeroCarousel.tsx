import { perf, tier } from "#devices/tier";
import { createEffect, createSignal, For, on, onCleanup } from "solid-js";
import { View } from "@solidtv/solid";
import type { Featured, Title } from "../api/types";
import { imageUrl } from "../api/client";
import { tmdbRating } from "../format";
import type { MetaPart } from "./MetaLine";
import { theme } from "../theme";
import { PillButton } from "./Button";
import { HEADER_H } from "./PageRows";
import { TitleHeader } from "./TitleHeader";
import { t as tr, tn } from "../i18n";

const { screen, color } = theme;
const SLIDE_MS = 9_000;
const BUTTONS_Y = HEADER_H - 170;

export const resumeAt = (t: Title) => (t.progress && !t.progress.finished ? t.progress.position_secs : 0);

/** "2004 · 1h 17m · Science Fiction, Drama", then the ratings as badges (their own line). */
function heroParts(f: Featured): MetaPart[] {
  const genres = (g: string | null) =>
    (g ?? "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");
  const score = f.movie?.rating ?? f.series?.rating ?? null;
  const ratings = (f.ratings?.length ? f.ratings : tmdbRating(score)).slice(0, 3).map(rating => ({ rating }));
  if (f.movie) {
    const mins = f.movie.duration_secs ? Math.round(f.movie.duration_secs / 60) : 0;
    const runtime = mins ? (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`) : "";
    return [f.movie.year?.toString() ?? "", runtime, genres(f.movie.genres), ...ratings];
  }
  const s = f.series!;
  return [s.year?.toString() ?? "", tn(s.seasons, "{n} season", "{n} seasons"), genres(s.genres), ...ratings];
}

/** Display fields of a hero slide, whether it's a movie or a show. */
export function slideInfo(f: Featured) {
  // Title logos cost texture memory: low-tier TVs show the name instead.
  const logo = tier === "high" ? (imageUrl(f.logo) ?? null) : undefined;
  if (f.movie) {
    const t = f.movie;
    return {
      title: t.title,
      parts: heroParts(f),
      logo,
      overview: t.overview,
      backdrop: t.backdrop,
      play: resumeAt(t) > 0 ? tr("Resume") : tr("Play"),
    };
  }
  const s = f.series!;
  const n = s.next;
  return {
    title: s.meta_title ?? s.series,
    parts: heroParts(f),
    logo,
    overview: s.overview,
    backdrop: s.backdrop,
    play: n
      ? tr(n.position_secs > 0 ? "Resume {ep}" : "Play {ep}", { ep: `S${n.season} E${n.episode}` })
      : tr("Episodes"),
  };
}

/**
 * Featured titles, one at a time: Play/Resume and More info, page dots, auto-advance every
 * few seconds while it's in view. Right past the last button shows the next
 * title; Left past the first shows the previous one.
 */
export function HeroCarousel(props: {
  slides: Featured[];
  /** Pauses auto-advance (e.g. while the rows below are focused). */
  active: boolean;
  /** Don't move on by itself (its preview clip is playing). */
  hold?: boolean;
  /** Fallback heading before anything loads. */
  placeholder: string;
  onCurrent: (f: Featured | undefined) => void;
  onPlay: (f: Featured) => void;
  onInfo: (f: Featured) => void;
}) {
  const [slide, setSlide] = createSignal(0);
  const count = () => props.slides.length;
  const index = () => slide() % Math.max(1, count());
  const current = () => props.slides[index()];
  const next = () => count() > 1 && setSlide(s => (s + 1) % count());
  const prev = () => setSlide(s => (s - 1 + count()) % count());

  createEffect(on(current, t => props.onCurrent(t)));
  // Low-tier TVs don't auto-advance: each title loads a full-screen backdrop (devices/tier.ts).
  const timer = setInterval(() => {
    if (props.active && !props.hold && perf.heroAutoAdvance) next();
  }, SLIDE_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <View width={screen.width} height={HEADER_H} forwardFocus={0}>
      <TitleHeader
        eyebrow={current() ? tr(current()!.reason) : undefined}
        title={current() ? slideInfo(current()!).title : props.placeholder}
        metaParts={current() ? slideInfo(current()!).parts : undefined}
        logo={current() ? slideInfo(current()!).logo : undefined}
        overview={current() ? slideInfo(current()!).overview : undefined}
        buttonsY={BUTTONS_Y}
        onRightEdge={next}
        // With one title there's nothing to go back to, so Left does nothing.
        onLeftEdge={count() > 1 ? prev : undefined}
      >
        <PillButton
          primary
          label={current() ? slideInfo(current()!).play : "Play"}
          width={300}
          onSelect={() => current() && props.onPlay(current()!)}
        />
        <PillButton
          label={tr("More info")}
          width={240}
          onSelect={() => current() && props.onInfo(current()!)}
        />
      </TitleHeader>
      <View x={screen.width / 2} mountX={0.5} y={HEADER_H - 60} width={count() * 24} height={10} skipFocus>
        <For each={props.slides}>
          {(_, i) => (
            <View
              x={i() * 24}
              width={i() === index() ? 20 : 10}
              height={10}
              borderRadius={5}
              color={i() === index() ? color.accent : 0xffffff66}
            />
          )}
        </For>
      </View>
    </View>
  );
}
