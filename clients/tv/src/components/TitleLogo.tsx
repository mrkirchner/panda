import { createSignal, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { displayText } from "../format";
import { theme } from "../theme";

const { color } = theme;

/**
 * A title's logo (its name as artwork), fitted inside `maxWidth` x `maxHeight` at its own
 * proportions once it has loaded; its name in large text meanwhile, and when there's no logo
 * or it doesn't load.
 */
export function TitleLogo(props: {
  src?: string | null;
  title: string;
  maxWidth: number;
  maxHeight: number;
}) {
  const [size, setSize] = createSignal<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = createSignal(false);
  const fit = () => {
    const s = size();
    if (!s) return { w: props.maxWidth, h: props.maxHeight };
    const k = Math.min(props.maxWidth / s.w, props.maxHeight / s.h);
    return { w: Math.round(s.w * k), h: Math.round(s.h * k) };
  };
  const shown = () => !!props.src && !failed() && !!size();
  return (
    <View width={props.maxWidth} height={props.maxHeight}>
      <Show when={props.src && !failed()}>
        <View
          src={props.src!}
          y={props.maxHeight - fit().h}
          width={fit().w}
          height={fit().h}
          // Not 0 while loading: the renderer only loads textures for nodes it would draw.
          alpha={shown() ? 1 : 0.001}
          onEvent={{
            loaded: (_, payload) => {
              const d = payload?.dimensions;
              if (d && d.w > 0 && d.h > 0) setSize({ w: d.w, h: d.h });
              else setFailed(true);
            },
            failed: () => setFailed(true),
          }}
        />
      </Show>
      {/* Its name, bottom-aligned in the box: up to two lines (a long name wraps, not cut). */}
      <Text
        y={props.maxHeight}
        mountY={1}
        width={props.maxWidth}
        contain="width"
        maxLines={2}
        fontSize={84}
        lineHeight={92}
        color={color.text}
        alpha={shown() ? 0 : 1}
      >
        {displayText(props.title) || " "}
      </Text>
    </View>
  );
}
