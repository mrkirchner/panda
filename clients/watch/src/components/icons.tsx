// Line icons drawn inline (no icon font, no requests): 24x24 paths in the current text color.
import type { JSX } from "@solidjs/web";

const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  tv: "M3 6h18v11H3zM8 21h8M12 17v4",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 21 21",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  play: "M7 4.5v15l13-7.5z",
  pause: "M7 4h4v16H7zM13 4h4v16h-4z",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5 10 17 19 7",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  eyeOff:
    "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.3 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  down: "M5 9l7 7 7-7",
  close: "M6 6l12 12M18 6 6 18",
  gear: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z",
  captions: "M3 5h18v14H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3",
  audio: "M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  pip: "M3 5h18v14H3zM12 12h7v5h-7z",
  volume: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
  back10: "M11 5 6 9l5 4M6 9h7a6 6 0 1 1-6 6",
  fwd10: "M13 5l5 4-5 4M18 9h-7a6 6 0 1 0 6 6",
  stack: "M4 8h16v11H4zM7 5h10M9 2h6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4",
  user: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  logout: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
  info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5v.5",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  timing: "M12 7v5l3 2M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z",
};

export type IconName = keyof typeof P;

export function Icon(props: { name: IconName; size?: number; class?: string; title?: string }): JSX.Element {
  const filled = () => props.name === "play" || props.name === "pause" || props.name === "bookmark";
  return (
    <svg
      class={["icon", props.class]}
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill={filled() ? "currentColor" : "none"}
      stroke={filled() ? "none" : "currentColor"}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.title ? undefined : "true"}
      role={props.title ? "img" : undefined}
    >
      {props.title ? <title>{props.title}</title> : null}
      <path d={P[props.name]} />
    </svg>
  );
}
