import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { voiceHeard, voiceState } from "../voice";
import { theme } from "../theme";
import { t } from "../i18n";

const { screen, color, font } = theme;
const W = 900;
const H = 150;

/** "Listening..." banner at the bottom of any screen while voice search runs. */
export function VoiceOverlay() {
  const shown = () => voiceState() !== "idle";
  const line = () =>
    voiceState() === "error"
      ? voiceHeard()
      : voiceHeard()
        ? `"${voiceHeard()}"`
        : t("Listening... say a movie or show");
  return (
    <View
      x={(screen.width - W) / 2}
      y={screen.height - H - 60}
      width={W}
      height={H}
      borderRadius={theme.radius.lg}
      color={theme.glass.panel}
      alpha={shown() ? 1 : 0}
      transition={{ alpha: { duration: 150 } }}
      zIndex={60}
      skipFocus
    >
      {/* Mic: a pulsing dot while listening. */}
      <View
        x={50}
        y={(H - 56) / 2}
        width={56}
        height={56}
        borderRadius={28}
        color={voiceState() === "error" ? color.error : color.surfaceFocus}
        zIndex={61}
      />
      <Text
        x={140}
        y={(H - font.body) / 2 - 2}
        width={W - 190}
        contain="width"
        maxLines={1}
        fontSize={font.body}
        color={color.text}
        zIndex={62}
      >
        {displayText(line()) || " "}
      </Text>
    </View>
  );
}
