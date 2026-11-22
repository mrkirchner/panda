import { Text, View } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { theme } from "../theme";
import { PillButton } from "./Button";
import { t } from "../i18n";

const { screen, color, font } = theme;
const W = 960;
const H = 400;
/** Opaque: page text draws in its own pass and would show through a translucent panel. */
const PANEL = (color.surface | 0xff) >>> 0;

/**
 * "Are you sure?" for something that can't be undone. Cancel has focus first, so a stray OK
 * never confirms; Back cancels. `danger` makes the confirm button red.
 */
export function ConfirmDialog(props: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Shown under the message after a failed attempt. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <View width={screen.width} height={screen.height} zIndex={40} onBack={() => (props.onCancel(), true)}>
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
          x={60}
          y={56}
          width={W - 120}
          contain="width"
          maxLines={1}
          fontSize={font.heading}
          color={color.text}
          zIndex={42}
        >
          {props.title}
        </Text>
        <Text
          x={60}
          y={124}
          width={W - 120}
          contain="width"
          maxLines={3}
          lineHeight={38}
          fontSize={font.body}
          color={color.textMuted}
          zIndex={42}
        >
          {props.message}
        </Text>
        <Text
          x={60}
          y={238}
          width={W - 120}
          contain="width"
          maxLines={1}
          fontSize={font.caption}
          color={color.error}
          alpha={props.error ? 1 : 0}
          zIndex={42}
        >
          {props.error || " "}
        </Text>
        <Row x={60} y={H - 64 - 50} width={W - 120} height={64} gap={theme.space.item} scroll="none" autofocus zIndex={42}>
          <PillButton label={t("Cancel")} width={240} onSelect={props.onCancel} />
          <PillButton
            danger={props.danger}
            label={props.confirmLabel}
            width={300}
            onSelect={props.onConfirm}
          />
        </Row>
      </View>
    </View>
  );
}
