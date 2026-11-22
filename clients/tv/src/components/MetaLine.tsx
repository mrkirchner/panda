import { For, Match, Switch } from "solid-js";
import { Text, View } from "@solidtv/solid";
import type { TitleRating } from "../api/types";
import { displayText } from "../format";
import { theme } from "../theme";

const { color, font } = theme;

/** One piece of a title's facts line: text ("2019", "Comedy") or a rating with its badge. */
export type MetaPart = string | { rating: TitleRating };

/** TMDB's logo (public/images/tmdb.svg) is 273.42 x 35.52. */
const TMDB_H = 16;
const TMDB_W = Math.round((TMDB_H * 273.42) / 35.52);
const BADGE_H = 26;

/**
 * Badges for the other sources, in each one's own colors (their names, not their logos:
 * those are trademarks).
 */
const BADGES: Record<string, { fill: number; text: number; width: number }> = {
  imdb: { fill: 0xf5c518ff, text: 0x000000ff, width: 58 },
  rotten_tomatoes: { fill: 0xfa320aff, text: 0xffffffff, width: 40 },
  metacritic: { fill: 0x66cc33ff, text: 0x000000ff, width: 44 },
};

function RatingBadge(props: { rating: TitleRating }) {
  const badge = () => BADGES[props.rating.source];
  return (
    <View display="flex" flexDirection="row" alignItems="center" gap={8} height={BADGE_H}>
      <Switch
        fallback={
          <Text fontSize={20} fontFamily="Roboto700" color={color.textMuted}>
            {displayText(props.rating.short)}
          </Text>
        }
      >
        <Match when={props.rating.source === "tmdb"}>
          <View width={TMDB_W} height={TMDB_H} src={`images/tmdb.svg?s=${TMDB_W}`} />
        </Match>
        <Match when={badge()}>
          {b => (
            <View width={b().width} height={BADGE_H} borderRadius={theme.radius.xs} color={b().fill}>
              <Text
                width={b().width}
                contain="width"
                y={0}
                lineHeight={BADGE_H}
                textAlign="center"
                fontSize={18}
                fontFamily="Roboto700"
                color={b().text}
              >
                {displayText(props.rating.short)}
              </Text>
            </View>
          )}
        </Match>
      </Switch>
      <Text fontSize={font.caption} color={color.text}>
        {displayText(props.rating.value)}
      </Text>
    </View>
  );
}

/**
 * A title's facts on one line, with its ratings as badges: "1993 · 1h 50m · Comedy ·
 * [TMDB] 7.0/10 · [IMDb] 6.8/10 · [RT] 95%". Parts with nothing to say are left out.
 */
export function MetaLine(props: { parts: MetaPart[] }) {
  const parts = () => props.parts.filter(p => (typeof p === "string" ? p.trim() !== "" : true));
  return (
    <View display="flex" flexDirection="row" alignItems="center" gap={14} height={BADGE_H + 4}>
      <For each={parts()}>
        {(p, i) => (
          <>
            {i() > 0 ? (
              <Text fontSize={font.caption} color={color.textMuted}>
                ·
              </Text>
            ) : null}
            {typeof p === "string" ? (
              <Text fontSize={font.caption} color={color.textMuted}>
                {displayText(p)}
              </Text>
            ) : (
              <RatingBadge rating={p.rating} />
            )}
          </>
        )}
      </For>
    </View>
  );
}
