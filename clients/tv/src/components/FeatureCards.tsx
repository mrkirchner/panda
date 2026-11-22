import { createSignal, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";
import { Artwork } from "./Artwork";
import type { CardProps } from "./Cards";
import { FocusRing } from "./FocusRing";

const { color, font, focus } = theme;
const RADIUS = theme.tile.radius;
const PAD = 22;

/** A tall "top pick": artwork cropped to fill, the title's logo (else its name), a details line
 *  and why it's picked, over a dark fade at the bottom. */
export const TALL = { width: 300, height: 450 };
/** A genre tile: its artwork washed in the genre's color, the name at the bottom. */
export const GENRE = { width: 260, height: 390 };

/** Bottom fade under the text (black: scrims never take a tint). */
function Fade(props: { width: number; height: number; from: number }) {
  return (
    <View
      y={props.height * props.from}
      width={props.width}
      height={props.height * (1 - props.from)}
      borderRadius={RADIUS}
      colorTop={0x00000000}
      colorBottom={0x000000e8}
    />
  );
}

/** Home's tall cards and genre tiles (`tall` / `genre` rows): `image` is a backdrop. */
export function FeatureCard(
  props: CardProps & {
    variant: "tall" | "genre";
    /** Title logo (tall cards). */
    logo?: string;
    /** Color wash over the artwork (genre tiles). */
    tint?: number;
    /** Why it's featured, under the details line (tall cards). */
    reason?: string;
  },
) {
  const [focused, setFocused] = createSignal(false);
  const [logoFailed, setLogoFailed] = createSignal(false);
  // Without artwork the fallback poster already shows the name: no second one over it.
  const [artMissing, setArtMissing] = createSignal(false);
  const tall = () => props.variant === "tall";
  const showLogo = () => !!props.logo && !logoFailed();
  return (
    <View
      item={props.item}
      width={props.width}
      height={props.height}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused?.();
      }}
      onEnter={() => (props.onSelect(), true)}
    >
      <View
        width={props.width}
        height={props.height}
        borderRadius={RADIUS}
        color={color.surface}
        scale={focused() ? focus.scale : 1}
        transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
      >
        <Artwork
          src={props.image}
          title={props.title}
          width={props.width}
          height={props.height}
          radius={RADIUS}
          textureOptions={{ resizeMode: { type: "cover", clipX: 0.5 } }}
          tint={props.tint}
          onMissing={setArtMissing}
        />
        <Fade width={props.width} height={props.height} from={tall() ? 0.35 : 0.55} />
        <Show
          when={tall()}
          fallback={
            <Show when={!artMissing()}>
              {/* Anchored at the bottom: a two-line name grows upward. */}
              <Text
                x={PAD}
                y={props.height - PAD}
                mountY={1}
                width={props.width - PAD * 2}
                contain="width"
                maxLines={2}
                fontFamily="Roboto700"
                fontSize={font.heading}
                color={color.text}
              >
                {displayText(props.title)}
              </Text>
            </Show>
          }
        >
          {/* Logo (or the name, up to two lines), the facts and why it's here, stacked from the
              bottom (a column sizes itself, so a long name pushes up, never into the facts). */}
          <View
            x={PAD}
            y={props.height - PAD + 8}
            mountY={1}
            width={props.width - PAD * 2}
            display="flex"
            flexDirection="column"
            flexBoundary="contain"
            gap={8}
          >
            <Show
              when={showLogo()}
              fallback={
                <Text
                  alpha={artMissing() ? 0 : 1}
                  width={props.width - PAD * 2}
                  contain="width"
                  maxLines={2}
                  lineHeight={(font.body + 4) * 1.2}
                  fontFamily="Roboto700"
                  fontSize={font.body + 4}
                  color={color.text}
                >
                  {displayText(props.title)}
                </Text>
              }
            >
              <View
                src={props.logo!}
                width={props.width - PAD * 2}
                height={96}
                textureOptions={{ resizeMode: { type: "contain" } }}
                onEvent={{ failed: () => setLogoFailed(true) }}
              />
            </Show>
            <Text
              width={props.width - PAD * 2}
              contain="width"
              maxLines={1}
              fontSize={font.caption - 2}
              color={color.text}
            >
              {displayText(props.meta ?? "")}
            </Text>
            <Text
              width={props.width - PAD * 2}
              contain="width"
              maxLines={1}
              fontSize={font.caption - 4}
              color={color.textMuted}
            >
              {displayText(props.reason ?? "") || " "}
            </Text>
          </View>
        </Show>
        <FocusRing width={props.width} height={props.height} radius={RADIUS} visible={focused()} />
      </View>
    </View>
  );
}
