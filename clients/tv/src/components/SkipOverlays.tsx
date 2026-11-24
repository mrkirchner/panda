// The player's "Skip intro" button and "Up next" card (playback/skips.ts decides when). Both show
// while the controls are hidden, drawn focused: OK skips or plays the next episode, Back puts the
// card away (the credits play on). Mounted always and toggled by alpha (Player's overlays rule).
import { Text, View } from "@solidtv/solid";
import { imageUrl } from "../api/client";
import type { NextUp } from "../api/types";
import { displayText } from "../format";
import { t } from "../i18n";
import { nextLabel } from "../playback/skips";
import { theme } from "../theme";
import { Label } from "./Label";

const { color } = theme;
const BUTTON_W = 260;
const BUTTON_H = 64;
const CARD_W = 520;
const STILL_H = 292;
const CARD_H = STILL_H + 196;
const RIGHT = theme.screen.width - theme.screen.gutter;
const BOTTOM = theme.screen.height - theme.screen.gutter;

/** "Skip intro", bottom right, in the focused look (OK presses it). */
export function SkipIntroButton(props: { visible: boolean }) {
  return (
    <View
      x={RIGHT - BUTTON_W}
      y={BOTTOM - BUTTON_H}
      width={BUTTON_W}
      height={BUTTON_H}
      borderRadius={theme.radius.sm}
      color={color.focusFill}
      alpha={props.visible ? 1 : 0}
      zIndex={30}
    >
      <Label text={t("Skip intro")} width={BUTTON_W} height={BUTTON_H} color={color.focusText} zIndex={31} />
    </View>
  );
}

/** The next episode: its still, "Next episode in 7", its number and name, and Play. */
export function UpNextCard(props: { visible: boolean; next: NextUp | null; secondsLeft: number | null }) {
  const label = () => (props.next ? nextLabel(props.next) : { heading: "", name: "" });
  const art = () => imageUrl(props.next?.still ?? props.next?.backdrop ?? null);
  const heading = () =>
    props.secondsLeft === null
      ? t("Up next")
      : t("Next episode in {secs}", { secs: String(props.secondsLeft) });
  return (
    <View
      x={RIGHT - CARD_W}
      y={BOTTOM - CARD_H}
      width={CARD_W}
      height={CARD_H}
      borderRadius={theme.radius.lg}
      color={theme.glass.panel}
      alpha={props.visible && props.next ? 1 : 0}
      zIndex={30}
      clipping
    >
      {/* A picture node's colour tints it: white with one, the raised grey without. */}
      <View
        width={CARD_W}
        height={STILL_H}
        color={art() ? 0xffffffff : color.raised}
        src={art()}
        zIndex={31}
      />
      <Text x={24} y={STILL_H + 20} fontSize={theme.font.caption} color={color.textMuted} zIndex={32}>
        {heading()}
      </Text>
      <Text
        x={24}
        y={STILL_H + 56}
        fontSize={theme.font.body}
        color={color.text}
        maxWidth={CARD_W - 48}
        maxLines={1}
        zIndex={32}
      >
        {displayText(`${label().heading}  ${label().name}`.trim()) || " "}
      </Text>
      <View
        x={24}
        y={CARD_H - 24 - BUTTON_H}
        width={CARD_W - 48}
        height={BUTTON_H}
        borderRadius={theme.radius.sm}
        color={color.focusFill}
        zIndex={31}
      >
        <Label
          text={t("Play next episode")}
          width={CARD_W - 48}
          height={BUTTON_H}
          color={color.focusText}
          zIndex={32}
        />
      </View>
    </View>
  );
}
