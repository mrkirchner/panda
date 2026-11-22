import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";

const { color } = theme;

/** Muted, dark tones for stand-in posters (white text reads on all of them). */
const TONES = [
  0x3b4a6bff, 0x5a3b5eff, 0x2f5a55ff, 0x6b4a33ff, 0x4a3b6bff, 0x33525eff, 0x5e3b3bff, 0x3e5a3bff,
];

export const tone = (title: string) => {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
};

/**
 * A poster for a title without artwork: a color picked from its title (stable per title), a
 * soft fade to dark, a faint film mark, and the title centered.
 */
export function PosterPlaceholder(props: { title: string; width: number; height: number; radius: number }) {
  const icon = () => Math.round(props.width * 0.22);
  return (
    <View
      width={props.width}
      height={props.height}
      borderRadius={props.radius}
      colorTop={tone(props.title)}
      colorBottom={0x141418ff}
    >
      <View
        src="images/icons/film.svg"
        x={(props.width - icon()) / 2}
        y={props.height * 0.22}
        width={icon()}
        height={icon()}
        color={0xffffff40}
      />
      <Text
        x={props.width / 2}
        mountX={0.5}
        y={props.height * 0.22 + icon() + 24}
        width={props.width - 36}
        contain="width"
        maxLines={4}
        textAlign="center"
        lineHeight={34}
        fontSize={28}
        fontFamily="Roboto700"
        color={color.text}
      >
        {displayText(props.title)}
      </Text>
    </View>
  );
}
