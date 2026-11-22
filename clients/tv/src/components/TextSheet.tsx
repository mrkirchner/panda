import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";

const { screen, color, font } = theme;
const W = 1240;
const H = 760;
/** Opaque: page text draws in its own pass and would show through a translucent panel. */
const PANEL = (color.surface | 0xff) >>> 0;

/**
 * A long text in full (a title's whole plot from its About card), over the page. OK or Back
 * closes it.
 */
export function TextSheet(props: { title: string; subtitle?: string; text: string; onClose: () => void }) {
  return (
    <View
      width={screen.width}
      height={screen.height}
      zIndex={40}
      autofocus
      onBack={() => (props.onClose(), true)}
      onEnter={() => (props.onClose(), true)}
    >
      <View width={screen.width} height={screen.height} color={0x000000cc} zIndex={40} />
      <View
        x={(screen.width - W) / 2}
        y={(screen.height - H) / 2}
        width={W}
        height={H}
        borderRadius={theme.radius.lg}
        color={PANEL}
        border={{ width: 2, color: theme.glass.edge }}
        zIndex={41}
      >
        <Text
          x={64}
          y={56}
          width={W - 128}
          contain="width"
          maxLines={1}
          fontSize={font.heading}
          color={color.text}
          zIndex={42}
        >
          {displayText(props.title)}
        </Text>
        <Text x={64} y={112} fontSize={20} letterSpacing={1.5} color={color.textMuted} zIndex={42}>
          {displayText(props.subtitle ?? "").toUpperCase()}
        </Text>
        <Text
          x={64}
          y={160}
          width={W - 128}
          contain="width"
          maxLines={14}
          lineHeight={40}
          fontSize={font.body}
          color={color.text}
          zIndex={42}
        >
          {displayText(props.text)}
        </Text>
      </View>
    </View>
  );
}
