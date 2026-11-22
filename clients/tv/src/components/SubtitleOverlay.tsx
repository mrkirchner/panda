import { For, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { absolute } from "../api/client";
import { placeImage, type BitmapCue, type BitmapManifest } from "../playback/bitmapSubs";
import { theme } from "../theme";

const { screen, font, color } = theme;
const WIDTH = 1600;
/** How far image subtitles move up while the player controls are open. */
const RAISE = 300;

/**
 * Subtitles drawn by the client on top of the video (never burned in by the server).
 * A shadow copy offset by a few pixels keeps text readable on bright scenes.
 *
 * The nodes stay mounted for the whole playback and only their text/alpha change per cue,
 * so the renderer never allocates or frees nodes while video is playing.
 */
export function SubtitleOverlay(props: {
  text: string;
  raised?: boolean;
  /** Image subtitles (PGS): the cue showing now, and its manifest's frame size. */
  bitmap?: BitmapCue | null;
  frame?: Pick<BitmapManifest, "video_width" | "video_height">;
}) {
  const line = (dx: number, dy: number, c: number) => (
    <Text
      x={dx}
      y={dy}
      width={WIDTH}
      contain="width"
      textAlign="center"
      maxLines={3}
      fontSize={font.subtitle}
      lineHeight={font.subtitle * 1.25}
      color={c}
    >
      {props.text || " "}
    </Text>
  );
  return (
    <>
      {/* Image subtitles keep their own position (as authored on the disc), at full screen scale. */}
      <Show when={props.bitmap} keyed>
        {cue => (
          <View width={screen.width} height={screen.height} zIndex={10} skipFocus>
            <For each={cue.images}>
              {img => {
                const p = placeImage(img, props.frame ?? { video_width: 1920, video_height: 1080 });
                return (
                  <View
                    src={absolute(img.url)}
                    x={p.x}
                    // Lower-screen subtitles move up above the player controls while they show
                    // (top-of-screen ones, like signs, stay put).
                    y={props.raised && p.y > screen.height / 2 ? p.y - RAISE : p.y}
                    width={p.width}
                    height={p.height}
                    transition={{ y: { duration: 200 } }}
                    zIndex={10}
                  />
                );
              }}
            </For>
          </View>
        )}
      </Show>
      <View
        x={(screen.width - WIDTH) / 2}
        // Move up while the player controls occupy the bottom of the screen.
        y={props.raised ? screen.height - 520 : screen.height - 240}
        width={WIDTH}
        height={200}
        zIndex={10}
        alpha={props.text ? 1 : 0}
      >
        {line(3, 3, color.shadow)}
        {line(0, 0, color.text)}
      </View>
    </>
  );
}
