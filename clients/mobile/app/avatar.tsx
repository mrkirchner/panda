// A profile's picture, as on the TV (../tv/src/components/Avatar.tsx): a bundled picture, a
// poster from the library (`art:<key>`, its upper part in the circle), else its initial on the
// profile's color.
import { imageUrl } from "@tv/api/client";
import { Show } from "solid-js";

const COLORS = ["#5b8cff", "#ff7a59", "#2ec4a6", "#b06cff", "#f2b84b", "#ff5c8a", "#4fc3f7"];

/** Stable color per name (the TV's), so a person is the same color everywhere. */
function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

const ART = "art:";

export function Avatar(props: { name: string; picture: string | null; size: number }) {
  const src = () => {
    const p = props.picture;
    if (!p) return undefined;
    return p.startsWith(ART) ? imageUrl(p.slice(ART.length)) : `~/images/avatars/${p}.png`;
  };
  return (
    <gridlayout
      width={props.size}
      height={props.size}
      borderRadius={props.size / 2}
      backgroundColor={avatarColor(props.name)}
      class="avatar-frame"
    >
      <label
        class="avatar-initial"
        fontSize={Math.round(props.size * 0.42)}
        text={props.name.slice(0, 1).toUpperCase() || "?"}
      />
      <Show when={src()}>
        <image
          width={props.size}
          height={props.size}
          borderRadius={props.size / 2}
          src={src()}
          stretch="aspectFill"
          verticalAlignment="top"
        />
      </Show>
    </gridlayout>
  );
}
