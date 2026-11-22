/**
 * Preview clips in browsers (and LG, Samsung, Android TV): a `<video>` of its own under the
 * Lightning canvas (index.html layers video at z-index 0, the canvas above it), placed over the
 * part of the screen the preview fills. The canvas is transparent there (App.tsx), so the clip
 * shows through while the UI draws on top.
 */
import { DESIGN_WIDTH } from "#devices/resolution";
import type { PreviewPlayer, PreviewRect } from "./preview";

let video: HTMLVideoElement | null = null;

function element(): HTMLVideoElement {
  if (video) return video;
  const v = document.createElement("video");
  v.setAttribute("playsinline", "");
  v.preload = "auto";
  Object.assign(v.style, {
    position: "fixed",
    zIndex: "0",
    objectFit: "cover",
    background: "black",
    pointerEvents: "none",
    display: "none",
  });
  document.body.appendChild(v);
  video = v;
  return v;
}

/** Put the element over `rect` (layout-grid units), or the whole canvas. */
function place(v: HTMLVideoElement, rect: PreviewRect | null): void {
  const canvas = document.querySelector("canvas");
  const box = canvas?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const s = box.width / DESIGN_WIDTH;
  const r = rect ?? { x: 0, y: 0, w: DESIGN_WIDTH, h: box.height / s, radius: 0 };
  Object.assign(v.style, {
    left: `${box.left + r.x * s}px`,
    top: `${box.top + r.y * s}px`,
    width: `${r.w * s}px`,
    height: `${r.h * s}px`,
    borderRadius: `${r.radius * s}px`,
    display: "block",
  });
}

export const browserPreviewPlayer: PreviewPlayer = {
  play(url, rect, volume, onPlaying, onEnded) {
    const v = element();
    place(v, rect);
    v.onplaying = () => onPlaying();
    v.onended = () => onEnded();
    v.onerror = () => onEnded();
    v.volume = Math.min(1, Math.max(0, volume));
    v.muted = volume === 0;
    v.src = url;
    // Autoplay with sound can be refused (no user gesture yet on some browsers): play muted.
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => onEnded());
    });
  },
  stop() {
    const v = video;
    if (!v) return;
    v.onplaying = v.onended = v.onerror = null;
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.style.display = "none";
  },
};
