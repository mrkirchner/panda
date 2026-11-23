// Preview clips on Android, as on the TV and the iPhone (clip.ios.ts): a ~30 s cut the server makes
// from a title, played over its artwork in the hero, a title's page and the expanded card. One at
// a time; quiet, or silent when the profile says so. The artwork stays until frames show (the clip
// fades in), and at the end it fades back to it. Media3 into a TextureView (it fades and clips like
// any view), scaled to fill.
import { Application, Placeholder, type ContentView, type View } from "@nativescript/core";
import { api } from "@tv/api/client";
import { currentUser } from "@tv/api/session";
import { refreshAll } from "./data";
import { STATE_BUFFERING, STATE_ENDED, coverTexture, listen, mediaItem, newPlayer, type Exo } from "./media3.android";

export type ClipSource = { kind: "title"; id: string } | { kind: "series"; name: string };

/** "Quiet": well under the volume a title plays at (the TV's). */
const QUIET = 0.2;

let current: { stop: () => void } | null = null;
let playerOpen = false;
export function setPlayerOpen(open: boolean) {
  playerOpen = open;
  if (open) stopClip();
  else setTimeout(refreshAll, 800);
}

let sheetOpen = false;
export function setSheetOpen(open: boolean) {
  sheetOpen = open;
  stopClip();
}

// Leaving the app: no clip keeps playing in the background.
Application.on(Application.backgroundEvent, () => stopClip());

export function stopClip() {
  current?.stop();
  current = null;
}

/**
 * Play `source`'s clip inside `host` (a ContentView laid over the artwork, transparent until the
 * clip shows). `onEnded` runs when it finished or couldn't play. Returns a handle that stops this
 * clip only.
 */
export function playClip(
  host: View,
  source: ClipSource,
  onEnded?: () => void,
  onPlaying?: () => void,
  inSheet = false,
): { stop: () => void } {
  const none = { stop: () => {} };
  if (playerOpen || !host.isLoaded || (sheetOpen && !inSheet)) return none;
  stopClip();
  const box = host as ContentView;
  let cancelled = false;
  let player: Exo | null = null;
  let unlisten: (() => void) | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const job = {
    stop: () => {
      cancelled = true;
      clearTimeout(stallTimer);
      unlisten?.();
      player?.release();
      player = null;
      box.opacity = 0;
      box.content = null as unknown as View;
    },
  };
  current = job;
  const finish = () => {
    if (current === job) stopClip();
    else job.stop();
    onEnded?.();
  };
  api.clip(source).then(
    ({ url }) => {
      if (cancelled || !url || !host.isLoaded) {
        if (!cancelled) onEnded?.();
        return;
      }
      const ctx = Application.android.context as android.content.Context;
      const texture = new android.view.TextureView(ctx);
      const holder = new Placeholder();
      holder.on("creatingView", (e: { view: unknown }) => (e.view = texture));
      box.opacity = 0;
      box.content = holder;
      const p = newPlayer();
      player = p;
      const volume = currentUser()?.previewSound === false ? 0 : QUIET;
      p.setVolume(volume);
      p.setVideoTextureView(texture);
      let shown = false;
      let size: [number, number] = [0, 0];
      texture.addOnLayoutChangeListener(
        new android.view.View.OnLayoutChangeListener({
          onLayoutChange: () => coverTexture(texture, size[0], size[1]),
        }),
      );
      unlisten = listen(p, {
        videoSize: (w, h) => {
          size = [w, h];
          coverTexture(texture, w, h);
        },
        firstFrame: () => {
          if (cancelled || shown) return;
          shown = true;
          void box.animate({ opacity: 1, duration: 600 });
          onPlaying?.();
        },
        playbackState: (s) => {
          if (cancelled) return;
          clearTimeout(stallTimer);
          // Stuck (an interruption, a stall) for a few seconds once showing: it's over.
          if (s === STATE_BUFFERING && shown) stallTimer = setTimeout(finish, 3000);
          if (s === STATE_ENDED) {
            void box.animate({ opacity: 0, duration: 600 });
            setTimeout(finish, 650);
          }
        },
        error: () => {
          if (!cancelled) finish();
        },
      });
      p.setMediaItem(mediaItem(url, false));
      p.prepare();
      p.play();
    },
    () => {
      if (!cancelled) onEnded?.();
    },
  );
  const gone = () => {
    if (current === job) stopClip();
  };
  host.once("unloaded", gone);
  const plainStop = job.stop;
  job.stop = () => {
    host.off("unloaded", gone);
    plainStop();
  };
  return {
    stop: () => {
      if (current === job) stopClip();
      else job.stop();
    },
  };
}
