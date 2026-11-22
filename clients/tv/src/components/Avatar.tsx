import { Show } from "solid-js";
import { View } from "@solidtv/solid";
import { Label } from "./Label";
import { displayText } from "../format";
import { imageUrl } from "../api/client";

const COLORS = [0x5b8cffff, 0xff7a59ff, 0x2ec4a6ff, 0xb06cffff, 0xf2b84bff, 0xff5c8aff, 0x4fc3f7ff];

/** Stable color per name, so a person is always the same color on every TV. */
export function avatarColor(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** A picture from a title's poster (Edit profile's "From your library"): this, then its image key. */
export const AVATAR_ART = "art:";
const artKey = (p: string | null | undefined) =>
  p?.startsWith(AVATAR_ART) ? p.slice(AVATAR_ART.length) : null;

/** The bundled avatar pictures (public/images/avatars). Keep in sync with the server's list. */
export const AVATARS = [
  "fox",
  "panda",
  "owl",
  "cat",
  "dog",
  "bear",
  "rabbit",
  "penguin",
  "frog",
  "lion",
  "whale",
  "koala",
  "robot",
  "alien",
  "rocket",
  "cactus",
] as const;

export function Avatar(props: {
  name: string;
  size: number;
  x?: number;
  y?: number;
  picture?: string | null;
}) {
  const fontSize = () => Math.round(props.size * 0.5);
  return (
    <View
      x={props.x ?? 0}
      y={props.y ?? 0}
      width={props.size}
      height={props.size}
      borderRadius={props.size / 2}
      color={avatarColor(props.name)}
    >
      <Label
        text={displayText(props.name.slice(0, 1).toUpperCase()) || "?"}
        width={props.size}
        height={props.size}
        size={fontSize()}
        color={0xffffffff}
        alpha={props.picture ? 0 : 1}
      />
      {/* A chosen picture covers the initial. */}
      <Show when={props.picture}>
        {/* Textures are cached by URL and an SVG is rasterized once, at the size of the first
            node using it, so `?s=` gives each drawn size its own sharp raster (else the 44px
            top bar's copy gets stretched to 372px). borderRadius: the rounded shader smooths
            the circle's edge. */}
        <View
          width={props.size}
          height={props.size}
          borderRadius={props.size / 2}
          // A poster: its upper part, where the faces usually are, cropped to the circle.
          src={
            artKey(props.picture)
              ? imageUrl(artKey(props.picture))
              : `images/avatars/${props.picture}.svg?s=${Math.round(props.size)}`
          }
          textureOptions={artKey(props.picture) ? { resizeMode: { type: "cover", clipY: 0.25 } } : undefined}
        />
      </Show>
    </View>
  );
}
