import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { trace, traceOn } from "#devices/debug";
import { View, type ElementNode, type NodeStyles } from "@solidtv/solid";
import { theme } from "../theme";
import { PosterPlaceholder } from "./PosterPlaceholder";

type State = "loading" | "loaded" | "failed";

/**
 * A card's artwork with a fallback that covers every way it can go missing: no image at all,
 * an image that fails to load (server down, network, a format the device can't decode) or one
 * that decodes to nothing (0x0). Until the image arrives the card is just its color block
 * (cheap: rows mount many cards while scrolling); if it never arrives, the full "no image"
 * poster (film mark and title) takes its place.
 */
export function Artwork(props: {
  src?: string | null;
  title: string;
  width: number;
  height: number;
  radius: number;
  /** Width of the image itself when it differs from the placeholder's (ExpandCard grows it). */
  imageWidth?: number;
  textureOptions?: NodeStyles["textureOptions"];
  alpha?: number;
  transition?: NodeStyles["transition"];
  /** Told whenever the fallback poster starts or stops standing in for the image. */
  onMissing?: (missing: boolean) => void;
  /** Multiplied into the image (a color wash, e.g. Home's genre tiles); white = as is. */
  tint?: number;
}) {
  const [state, setState] = createSignal<State>("loading");
  // A new image starts over (cards are reused as virtual rows scroll).
  createEffect(
    on(
      () => props.src,
      () => setState("loading"),
      { defer: true },
    ),
  );
  const missing = () => !props.src || state() === "failed";
  let image: ElementNode | undefined;
  // Dev builds: report artwork that neither loads nor fails (devices/debug.ts).
  if (traceOn()) {
    createEffect(
      on(
        () => props.src,
        src => {
          if (!src) return;
          const timer = setTimeout(() => {
            if (state() !== "loading") return;
            const node = image as unknown as
              { imageState?: string; texture?: { state?: string } } | undefined;
            trace(
              `artwork still loading after 20s: ${src.replace(/^.*\/api\/images\//, "").replace(/\?.*$/, "")} ` +
                `imageState=${node?.imageState} texture=${node?.texture?.state ?? "none"}`,
            );
          }, 20_000);
          onCleanup(() => clearTimeout(timer));
        },
      ),
    );
  }
  createEffect(on(missing, m => props.onMissing?.(m)));
  return (
    <View alpha={props.alpha ?? 1} transition={props.transition}>
      <Show when={!missing() && state() === "loading"}>
        <View
          width={props.width}
          height={props.height}
          borderRadius={props.radius}
          // Neutral while loading (a title's own color is for artwork that's missing).
          color={theme.glass.thin}
        />
      </Show>
      <Show when={missing()}>
        <PosterPlaceholder
          title={props.title}
          width={props.width}
          height={props.height}
          radius={props.radius}
        />
      </Show>
      <Show when={props.src && state() !== "failed"}>
        <View
          ref={el => (image = el)}
          src={props.src!}
          width={props.imageWidth ?? props.width}
          height={props.height}
          borderRadius={props.radius}
          textureOptions={props.textureOptions}
          color={props.tint ?? 0xffffffff}
          transition={props.transition}
          onEvent={{
            loaded: (_, payload) => {
              const d = payload?.dimensions;
              setState(d && (d.w === 0 || d.h === 0) ? "failed" : "loaded");
            },
            failed: (_, payload) => {
              trace(`artwork failed: ${String(payload?.error ?? "?").replace(/\?[^ ]*/, "?…")}`);
              setState("failed");
            },
          }}
        />
      </Show>
    </View>
  );
}
