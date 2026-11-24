// A profile's picture, as on the TV (../tv/src/components/Avatar.tsx): a bundled picture, a
// poster from the library (`art:<key>`, its upper part in the circle), else its initial on the
// profile's color.
import { imageUrl } from "@tv/api/client";
import { Show } from "solid-js";

const COLORS = ["#5b8cff", "#ff7a59", "#2ec4a6", "#b06cff", "#f2b84b", "#ff5c8a", "#4fc3f7"];

/** Stable color per name (the TV's), so a person is the same color everywhere. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export const ART = "art:";

/** The bundled pictures (the TV's public/images/avatars; keep in step with AVATARS in
 * routes/auth.rs). */
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

export const avatarSrc = (picture: string | null | undefined): string | undefined => {
  if (!picture) return undefined;
  return picture.startsWith(ART)
    ? imageUrl(picture.slice(ART.length))
    : `${import.meta.env.BASE_URL}images/avatars/${picture}.svg`;
};

export function Avatar(props: {
  name: string;
  picture: string | null | undefined;
  size: number;
  class?: string;
}) {
  return (
    <span
      class={["avatar", props.class]}
      style={{
        width: `${props.size}px`,
        height: `${props.size}px`,
        "background-color": avatarColor(props.name),
        "font-size": `${Math.round(props.size * 0.42)}px`,
      }}
    >
      <span class="avatar-initial">{props.name.slice(0, 1).toUpperCase() || "?"}</span>
      <Show when={avatarSrc(props.picture)}>
        {(src) => (
          <img
            class={["avatar-img", { art: !!props.picture?.startsWith(ART) }]}
            src={src()}
            alt=""
            loading="lazy"
            decoding="async"
          />
        )}
      </Show>
    </span>
  );
}
