import { View } from "@solidtv/solid";
import { theme, withAlpha } from "../theme";

const { screen, color } = theme;

/**
 * Full-screen artwork with left and bottom scrims so text on top stays readable. `dim` keeps
 * it faint behind page content; `hidden` fades it out entirely (Home, once you're past the hero).
 */
export function Backdrop(props: { src?: string; dim?: boolean; hidden?: boolean; video?: boolean }) {
  return (
    <View width={screen.width} height={screen.height}>
      <View
        src={props.src}
        width={screen.width}
        height={screen.height}
        alpha={props.src && !props.hidden && !props.video ? (props.dim ? 0.3 : 1) : 0}
        transition={{ alpha: { duration: 600 } }}
      />
      {/* The scrims go too when it's hidden (over the plain background they show nothing, and a
          card's preview clip plays through a hole under them). */}
      <View width={screen.width} height={screen.height} alpha={props.hidden ? 0 : 1}>
        {/* Top: keeps the nav and clock readable over bright skies. */}
        <View
          width={screen.width}
          height={220}
          colorTop={withAlpha(color.shadow, 0x99)}
          colorBottom={withAlpha(color.shadow, 0)}
        />
        {/* Left: strong behind the text column, then fading across the picture (two views,
          since each gradient has only two stops). */}
        <View
          width={1000}
          height={screen.height}
          colorLeft={withAlpha(color.background, 0xf2)}
          colorRight={withAlpha(color.background, 0xb3)}
        />
        <View
          x={1000}
          width={700}
          height={screen.height}
          colorLeft={withAlpha(color.background, 0xb3)}
          colorRight={withAlpha(color.background, 0)}
        />
        <View
          y={screen.height - 560}
          width={screen.width}
          height={560}
          colorTop={withAlpha(color.background, 0)}
          colorBottom={color.background}
        />
      </View>
    </View>
  );
}
