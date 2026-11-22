import { perf } from "#devices/tier";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row, VirtualRow } from "@solidtv/solid/primitives";
import type { Item } from "../api/types";
import { displayText, formatTime, longDate } from "../format";
import { t } from "../i18n";
import { theme } from "../theme";
import { MetaLine, type MetaPart } from "./MetaLine";
import { holdAnimations } from "../focusMemory";
import { Artwork } from "./Artwork";
import { Tab } from "./Button";
import { FocusRing } from "./FocusRing";

const { screen, color, font, focus } = theme;

const CARD_W = 560;
const CARD_H = 315;
/** Wide enough that a focused card (scaleWide) never meets its neighbour. */
const GAP = theme.space.item;
const TABS_H = 76;
const EDGE = theme.tabContentTop;
/** An anthology season's story band above the tabs. */
const STORY_H = 190;
/** The section's height: season tabs, then a row of episode cards with room for focus. */
export const EPISODES_H = TABS_H + EDGE + CARD_H + EDGE + 10;

/** One card in the row: an episode you have, or one still to air. */
export interface EpisodeEntry {
  item?: Item;
  upcoming?: {
    season: number;
    episode: number;
    name: string | null;
    overview: string | null;
    airDate: string | null;
  };
}

function EpisodeCard(props: {
  entry: EpisodeEntry;
  thumb?: string;
  onSelect: () => void;
  onFocused?: () => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const e = () => props.entry.item;
  const up = () => props.entry.upcoming;
  const number = () => e()?.episode ?? up()?.episode;
  const name = () => e()?.episode_title ?? up()?.name ?? e()?.title ?? "";
  const overview = () => e()?.episode_overview ?? up()?.overview ?? "";
  const fraction = () => (e()?.progress && !e()!.progress!.finished ? e()!.progress!.fraction : 0);
  const foot = () => {
    if (up()) {
      const when = longDate(up()!.airDate);
      return when ? t("Coming {date}", { date: when }) : t("Coming soon");
    }
    const secs = e()?.duration_secs ?? 0;
    if (fraction() > 0 && secs) return t("{t} left", { t: formatTime(secs * (1 - fraction())) });
    return secs ? `${Math.round(secs / 60)}m` : "";
  };
  return (
    <View
      width={CARD_W}
      height={CARD_H}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused?.();
      }}
      onEnter={() => {
        props.onSelect();
        return true;
      }}
      scale={focused() ? focus.scaleWide : 1}
      transition={{ scale: { duration: focus.duration } }}
    >
      <FocusRing width={CARD_W} height={CARD_H} radius={theme.radius.lg} visible={focused()} />
      <Artwork
        src={props.thumb}
        title={name()}
        width={CARD_W}
        height={CARD_H}
        radius={theme.radius.lg}
        // Episodes still to air are greyed.
        tint={up() ? 0x777777ff : undefined}
      />
      {/* Darkened toward the bottom, under the text. */}
      <View
        y={CARD_H * 0.15}
        width={CARD_W}
        height={CARD_H * 0.85}
        borderRadius={theme.radius.lg}
        colorTop={0x00000000}
        colorBottom={0x000000f2}
      />
      <Text x={24} y={CARD_H - 196} fontSize={20} letterSpacing={1.5} color={color.textMuted}>
        {(number() != null ? t("Episode {n}", { n: number()! }) : "").toUpperCase()}
      </Text>
      <Text
        x={24}
        y={CARD_H - 168}
        width={CARD_W - 48}
        contain="width"
        maxLines={1}
        fontSize={font.body}
        color={color.text}
      >
        {displayText(name())}
      </Text>
      <Text
        x={24}
        y={CARD_H - 126}
        width={CARD_W - 48}
        contain="width"
        maxLines={2}
        lineHeight={30}
        fontSize={22}
        color={color.textMuted}
      >
        {displayText(overview())}
      </Text>
      <Text x={24} y={CARD_H - 50} fontSize={20} color={color.text}>
        {displayText(foot())}
      </Text>
      <Show when={fraction() > 0}>
        <View x={24} y={CARD_H - 18} width={CARD_W - 48} height={5} borderRadius={3} color={0xffffff33}>
          <View width={(CARD_W - 48) * fraction()} height={5} borderRadius={3} color={color.focusFill} />
        </View>
      </Show>
      <Show when={e()?.progress?.finished}>
        <View x={CARD_W - 56} y={18} width={38} height={38} borderRadius={19} color={0x000000b3}>
          <Text x={0} y={5} width={38} contain="width" textAlign="center" fontSize={22} color={color.text}>
            ✓
          </Text>
        </View>
      </Show>
    </View>
  );
}

/**
 * A show's episodes, Apple TV style: season tabs above one row of large cards (still, number,
 * name, plot, time), and the next episode still to air at the end of its season, greyed with
 * its date. Every season is one row (Right runs on into the next); a season tab jumps to its
 * first episode, and follows the episode you're on.
 */
export function EpisodesSection(props: {
  /** An anthology season's own story (its title, facts and plot), shown above the tabs. */
  story?: { title: string; parts: MetaPart[]; overview: string | null | undefined };
  /** Focus entered or left the section (the page brightens its backdrop meanwhile). */
  onFocused?: (focused: boolean) => void;
  seasons: { title: string; entries: EpisodeEntry[] }[];
  season: number;
  onSeason: (i: number) => void;
  /** Left the season tabs (to put back a season passed on the way, see the show page). */
  onLeaveSeasons?: () => void;
  thumb: (e: EpisodeEntry) => string | undefined;
  onPlay: (item: Item) => void;
}) {
  let column: ElementNode | undefined;
  let row: ElementNode | undefined;
  /** Every season's episodes in one row (Right runs on into the next season). */
  const all = createMemo(() =>
    props.seasons.flatMap((s, season) => s.entries.map(entry => ({ entry, season }))),
  );
  /** Where each season starts in the row. */
  const firstOf = (season: number) => all().findIndex(e => e.season === season);
  /** The episode the row is on (its place in `all`). */
  let cur = Math.max(
    0,
    untrack(() => firstOf(props.season)),
  );
  /** A season picked on the tabs: the row goes to its first episode when you go down to it. */
  let wanted = -1;
  /** Stepping to a picked season's first episode: the episodes passed (and the one the row
   * opens on, before the steps) don't change the season. */
  let arriving = false;
  const jumpTo = (season: number) => {
    wanted = firstOf(season);
  };
  /** Going down into the row after picking a season: step there instantly (as moving would,
   * so the row's scrolling stays right). */
  /** A jump is under way: the row is hidden until it lands (no whizzing past every episode). */
  const [jumping, setJumping] = createSignal(false);
  const arrive = () => {
    const target = wanted;
    wanted = -1;
    const r = row as unknown as { onRight?: () => boolean; onLeft?: () => boolean } | undefined;
    if (target < 0 || !r) return;
    let steps = target - cur;
    if (steps === 0) return setJumping(false);
    // Animations off for the whole jump, and the season set once at the end: cards and tabs
    // passed on the way otherwise keep a half-run fade (a ring, an underline).
    const end = holdAnimations();
    arriving = true;
    const step = () => {
      if (steps === 0) {
        arriving = false;
        const season = all()[cur]?.season;
        if (season != null && season !== props.season) props.onSeason(season);
        setJumping(false);
        end();
        return;
      }
      (steps > 0 ? r.onRight : r.onLeft)?.call(row);
      steps += steps > 0 ? -1 : 1;
      // The row rebuilds its window after each step (a microtask): the next one after that.
      setTimeout(step, 0);
    };
    step();
  };
  const visible = Math.ceil(screen.width / (CARD_W + GAP)) + 1;
  return (
    <View
      width={screen.width}
      height={EPISODES_H + (props.story ? STORY_H : 0)}
      forwardFocus={1}
      onFocusChanged={(f: boolean) => props.onFocused?.(f)}
    >
      {/* Not focusable: the section forwards focus to its Column (child 1). */}
      <Show when={props.story} fallback={<View width={1} height={1} skipFocus />}>
        {st => (
          <View
            x={screen.gutter}
            width={screen.width - screen.gutter * 2}
            height={STORY_H}
            skipFocus
            display="flex"
            flexDirection="column"
            flexBoundary="contain"
            gap={10}
          >
            <Text fontSize={font.heading} color={color.text} maxLines={1} contain="width" width={1400}>
              {displayText(st().title)}
            </Text>
            <MetaLine parts={st().parts} />
            <Text
              width={1300}
              contain="width"
              maxLines={2}
              lineHeight={font.caption * 1.35}
              fontSize={font.caption}
              color={color.textMuted}
            >
              {displayText(st().overview ?? "")}
            </Text>
          </View>
        )}
      </Show>
      <Column
        ref={column}
        y={props.story ? STORY_H : 0}
        width={screen.width}
        height={EPISODES_H}
        gap={0}
        scroll="none"
        selected={1}
      >
        <View width={screen.width} height={TABS_H} forwardFocus={0}>
          <Row
            x={screen.gutter}
            y={10}
            width={screen.width - screen.gutter * 2}
            height={52}
            gap={theme.space.item}
            scroll="auto"
            selected={props.season}
            onBlur={() => props.onLeaveSeasons?.()}
          >
            <For each={props.seasons}>
              {(s, i) => (
                <Tab
                  label={s.title}
                  selected={i() === props.season}
                  onFocused={() => {
                    props.onSeason(i());
                    jumpTo(i());
                  }}
                  // OK: down to the season's first episode (as Down does).
                  onEnter={() => {
                    jumpTo(i());
                    const col = column as unknown as { onDown?: () => boolean } | undefined;
                    col?.onDown?.call(column);
                  }}
                />
              )}
            </For>
          </Row>
        </View>
        <View width={screen.width} height={EDGE + CARD_H + EDGE} clipping forwardFocus={0}>
          <VirtualRow
            ref={(el: ElementNode) => (row = el)}
            onFocusChanged={(f: boolean) => {
              if (!f) return;
              // Hidden from the first frame, before the steps start.
              if (wanted >= 0 && wanted !== cur) setJumping(true);
              setTimeout(arrive, 0);
            }}
            alpha={jumping() ? 0 : 1}
            // Opens on the season you're up to (later seasons are reached by moving or a tab).
            selected={cur}
            x={screen.gutter}
            y={EDGE}
            width={screen.width - screen.gutter}
            height={CARD_H}
            gap={GAP}
            each={all()}
            displaySize={visible}
            bufferSize={perf.listBuffer}
            uniformSize
            scroll="always"
          >
            {e => (
              <EpisodeCard
                // The season tab follows the episode you're on.
                onFocused={() => {
                  cur = all().indexOf(e());
                  if (!arriving && wanted < 0 && e().season !== props.season) props.onSeason(e().season);
                }}
                entry={e().entry}
                thumb={props.thumb(e().entry)}
                onSelect={() => e().entry.item && props.onPlay(e().entry.item!)}
              />
            )}
          </VirtualRow>
        </View>
      </Column>
    </View>
  );
}
