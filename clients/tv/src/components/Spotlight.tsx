import { createSignal, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";
import { Artwork } from "./Artwork";
import { FocusRing } from "./FocusRing";

const { screen, color, font, focus } = theme;
const RADIUS = theme.radius.lg;
const W = screen.width - screen.gutter * 2;
const H = 420;
/** The artwork's width: it sits on the right, fading into black on the left. */
const ART_W = 1240;
const FADE_W = 520;
const PAD = 60;
/** Room around the banner in a page's rows: a focused banner grows a little. */
export const SPOTLIGHT_ROW_H = H + 60;

/**
 * A wide feature banner between Home's rows: the backdrop on the right fading into black, the
 * title's logo (else its name), a details line ("Movie · Drama · Comedy") and why it's there.
 */
export function Spotlight(props: {
  title: string;
  backdrop?: string;
  logo?: string;
  meta: string;
  reason: string;
  onSelect: () => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [logoFailed, setLogoFailed] = createSignal(false);
  // No artwork: the banner stays black (the logo and text carry it) rather than a placeholder.
  const [artMissing, setArtMissing] = createSignal(false);
  return (
    <View width={screen.width} height={SPOTLIGHT_ROW_H} forwardFocus={0}>
      <View
        x={screen.gutter}
        y={20}
        width={W}
        height={H}
        borderRadius={RADIUS}
        color={0x000000ff}
        scale={focused() ? focus.scaleWide : 1}
        transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
        onFocusChanged={setFocused}
        onEnter={() => (props.onSelect(), true)}
      >
        <View
          x={W - ART_W}
          width={ART_W}
          height={H}
          borderRadius={RADIUS}
          clipping
          alpha={artMissing() ? 0 : 1}
        >
          <Artwork
            src={props.backdrop}
            title={props.title}
            width={ART_W}
            height={H}
            radius={RADIUS}
            textureOptions={{ resizeMode: { type: "cover", clipY: 0.3 } }}
            onMissing={setArtMissing}
          />
          {/* The artwork's left edge fades into the banner's black. */}
          <View width={FADE_W} height={H} colorLeft={0x000000ff} colorRight={0x00000000} />
        </View>
        {/* Logo (or the name, up to two lines), the details and why it's here, stacked from the
            bottom (a column sizes itself, so a long name pushes up, never into the details). */}
        <View
          x={PAD}
          y={H - 40}
          mountY={1}
          width={700}
          display="flex"
          flexDirection="column"
          flexBoundary="contain"
          gap={10}
        >
          <Show
            when={props.logo && !logoFailed()}
            fallback={
              <Text
                width={620}
                contain="width"
                maxLines={2}
                lineHeight={font.title * 1.15}
                fontFamily="Roboto700"
                fontSize={font.title}
                color={color.text}
              >
                {displayText(props.title)}
              </Text>
            }
          >
            <View
              src={props.logo!}
              width={520}
              height={140}
              textureOptions={{ resizeMode: { type: "contain" } }}
              onEvent={{ failed: () => setLogoFailed(true) }}
            />
          </Show>
          <Text width={700} contain="width" maxLines={1} fontSize={font.body} color={color.text}>
            {displayText(props.meta)}
          </Text>
          <Text width={700} contain="width" maxLines={1} fontSize={font.caption} color={color.textMuted}>
            {displayText(props.reason) || " "}
          </Text>
        </View>
        <FocusRing width={W} height={H} radius={RADIUS} visible={focused()} />
      </View>
    </View>
  );
}
