import { Text, View, type ElementNode } from "@solidtv/solid";
import { describeTiming, shortTiming, TIMING_STEP } from "../playback/subtitles";
import { theme, withAlpha } from "../theme";
import { t } from "../i18n";

const { screen, color, font } = theme;
const W = 760;
const H = 210;

/**
 * Subtitle timing: Left/Right move the subtitles 0.1 s earlier/later, Up/Down a whole second,
 * OK or Back closes. Sits at the top so the subtitles and picture stay in view while you match
 * them up. Always mounted; it fades with `alpha`, so opening never builds nodes.
 */
export function SubtitleTiming(props: {
  open: boolean;
  /** Seconds; positive shows subtitles later. */
  value: number;
  onChange: (secs: number) => void;
  onClose: () => void;
  ref: (el: ElementNode) => void;
}) {
  const step = (by: number) => (props.onChange(props.value + by), true);
  return (
    <View
      ref={props.ref}
      x={(screen.width - W) / 2}
      y={60}
      width={W}
      height={H}
      borderRadius={theme.radius.lg}
      color={withAlpha(color.raised, 0xf2)}
      border={{ width: 2, color: theme.glass.edge }}
      alpha={props.open ? 1 : 0}
      skipFocus={!props.open}
      transition={{ alpha: { duration: 160 } }}
      zIndex={40}
      onLeft={() => step(-TIMING_STEP)}
      onRight={() => step(TIMING_STEP)}
      onUp={() => step(1)}
      onDown={() => step(-1)}
      onEnter={() => (props.onClose(), true)}
      onBack={() => (props.onClose(), true)}
    >
      <Text x={W / 2} mountX={0.5} y={24} fontSize={font.caption} color={color.textMuted} zIndex={41}>
        {t("Subtitle timing")}
      </Text>
      {/* Arrows either side of the value, like a stepper. */}
      <Text x={60} y={66} fontSize={font.heading} color={color.text} zIndex={41}>
        {"<"}
      </Text>
      <Text x={W / 2} mountX={0.5} y={62} fontSize={font.title} color={color.accent} zIndex={41}>
        {shortTiming(props.value)}
      </Text>
      <Text x={W - 60} mountX={1} y={66} fontSize={font.heading} color={color.text} zIndex={41}>
        {">"}
      </Text>
      <Text
        x={W / 2}
        mountX={0.5}
        y={146}
        width={W - 60}
        contain="width"
        textAlign="center"
        maxLines={1}
        fontSize={font.caption}
        color={color.textMuted}
        zIndex={41}
      >
        {`${describeTiming(props.value)}   |   ${t("Left/Right: 0.1 s   Up/Down: 1 s   OK: done")}`}
      </Text>
    </View>
  );
}
