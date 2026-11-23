// Preview clips (the server's ~30 s 720p MP4s, `panda_media::clip`), as on the TV and the phone:
// one plays at a time, over the hero's backdrop or inside an expanded card, quietly (0.2) when
// the profile has preview sound on and the browser allows sound, else silent. None while the
// page is hidden, when the person asked the system for reduced motion, or with data saver on.
import { api } from "@tv/api/client";
import { currentUser } from "@tv/api/session";

export type ClipSource = { kind: "title"; id: string } | { kind: "series"; name: string };

interface Job {
  stop: () => void;
}
let current: Job | null = null;
/** No clips while the player is open. */
let playerOpen = false;
export const setPlayerOpen = (open: boolean) => {
  playerOpen = open;
  if (open) stopClip();
};

/** Clips are off for this browser (reduced motion, data saver). */
function clipsOff(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!conn?.saveData || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function stopClip() {
  const c = current;
  current = null;
  c?.stop();
}

/**
 * Play `source`'s clip in `host` (an element over the artwork). `onEnded`: it finished or couldn't
 * play (the hero moves on then); `onPlaying`: it's showing. Returns a handle that stops this clip
 * only (not one another part of the page started since).
 */
export function playClip(
  host: HTMLElement,
  source: ClipSource,
  onEnded?: () => void,
  onPlaying?: () => void,
): Job {
  if (playerOpen || document.hidden || clipsOff() || !host.isConnected) {
    onEnded?.();
    return { stop: () => {} };
  }
  stopClip();
  let cancelled = false;
  let video: HTMLVideoElement | null = null;
  const job: Job = {
    stop: () => {
      cancelled = true;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
        video = null;
      }
      if (current === job) current = null;
    },
  };
  current = job;
  api.clip(source).then(
    ({ url }) => {
      if (cancelled || !url || !host.isConnected) {
        if (!cancelled) onEnded?.();
        return;
      }
      const v = document.createElement("video");
      video = v;
      v.playsInline = true;
      v.preload = "auto";
      v.src = url;
      const sound = currentUser()?.previewSound ?? true;
      v.muted = !sound;
      v.volume = 0.2;
      v.addEventListener("playing", () => {
        if (cancelled) return;
        v.classList.add("shown");
        onPlaying?.();
      });
      const end = () => {
        if (cancelled) return;
        v.classList.remove("shown");
        setTimeout(() => {
          if (current === job) stopClip();
          else job.stop();
          onEnded?.();
        }, 600);
      };
      v.addEventListener("ended", end);
      v.addEventListener("error", end);
      host.appendChild(v);
      v.play().catch(() => {
        // Sound before any click on the page isn't allowed: play it silent instead.
        if (cancelled) return;
        v.muted = true;
        v.play().catch(end);
      });
    },
    () => {
      if (!cancelled) onEnded?.();
    },
  );
  return job;
}

// Another tab or the window minimised: no clip keeps playing.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopClip();
});
