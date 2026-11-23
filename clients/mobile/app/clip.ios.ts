// Preview clips, as on the TV (../tv/src/playback/preview.ts): a ~30 s cut the server makes from a
// title (`/api/titles/{id}/clip`, a show's from its first episode), played over its artwork in
// the hero, a title's page and the expanded card. One at a time; quiet, or silent when the
// profile says so (Edit profile's Preview sound). The artwork stays until frames show, so
// nothing flashes black; at the end the clip fades back to it.
import { Application, type View } from "@nativescript/core";
import { api } from "@tv/api/client";
import { currentUser } from "@tv/api/session";
import { refreshAll } from "./data";
import type { ClipSource } from "./platformTypes";


/** "Quiet": well under the volume a title plays at (the TV's). */
const QUIET = 0.2;

let current: { stop: () => void } | null = null;
/** The full player is open: no clips meanwhile (player.ts). */
let playerOpen = false;
export function setPlayerOpen(open: boolean) {
  playerOpen = open;
  if (open) stopClip();
  // Closed: the screens behind show the new resume point and Watched marks (the server has the
  // last position by then; it's saved as the player closes).
  else setTimeout(refreshAll, 800);
}

/** A sheet (the expanded tile) is open: only its clip plays, not the page's behind it. */
let sheetOpen = false;
export function setSheetOpen(open: boolean) {
  sheetOpen = open;
  stopClip();
}

// Leaving the app: no clip keeps playing (or polling) in the background.
Application.on(Application.backgroundEvent, () => stopClip());

/** Stop whatever clip is playing (a title starting, the screen going away). */
export function stopClip() {
  current?.stop();
  current = null;
}

/**
 * Play `source`'s clip inside `host` (a NativeScript view laid over the artwork, transparent until
 * the clip shows). `onEnded` runs when it finished or couldn't play (the hero moves on then).
 * Returns a handle that stops this clip only.
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
  let cancelled = false;
  let player: AVPlayer | null = null;
  let layer: AVPlayerLayer | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  const fit = () => {
    const native = host.ios as UIView | undefined;
    if (layer && native) layer.frame = native.bounds;
  };
  const job = {
    stop: () => {
      cancelled = true;
      clearInterval(poll);
      host.off("layoutChanged", fit);
      player?.pause();
      player?.replaceCurrentItemWithPlayerItem(null);
      layer?.removeFromSuperlayer();
      const native = host.ios as UIView | undefined;
      if (native) native.alpha = 0;
      player = null;
      layer = null;
    },
  };
  current = job;
  api.clip(source).then(
    ({ url }) => {
      const native = host.ios as UIView | undefined;
      if (cancelled || !url || !native) {
        if (!cancelled) onEnded?.();
        return;
      }
      const item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(url));
      player = AVPlayer.playerWithPlayerItem(item);
      const volume = currentUser()?.previewSound === false ? 0 : QUIET;
      player.volume = volume;
      player.muted = volume === 0;
      layer = AVPlayerLayer.playerLayerWithPlayer(player);
      layer.videoGravity = AVLayerVideoGravityResizeAspectFill;
      native.alpha = 0;
      native.clipsToBounds = true;
      native.layer.addSublayer(layer);
      fit();
      host.on("layoutChanged", fit);
      player.play();
      let shown = false;
      let stalledSince = 0;
      poll = setInterval(() => {
        const p = player;
        if (!p) return;
        const t = CMTimeGetSeconds(p.currentTime());
        // Paused or stuck (an interruption, a stall) for a few seconds: it's over.
        if (shown && p.timeControlStatus !== AVPlayerTimeControlStatus.Playing) {
          stalledSince ||= Date.now();
          if (Date.now() - stalledSince > 3000) {
            clearInterval(poll);
            if (current === job) stopClip();
            else job.stop();
            onEnded?.();
            return;
          }
        } else stalledSince = 0;
        if (!shown && p.timeControlStatus === AVPlayerTimeControlStatus.Playing && t > 0) {
          shown = true;
          UIView.animateWithDurationAnimations(0.6, () => (native.alpha = 1));
          onPlaying?.();
        }
        const d = CMTimeGetSeconds(item.duration);
        const failed = item.status === AVPlayerItemStatus.Failed;
        if (failed || (shown && Number.isFinite(d) && t >= d - 0.6)) {
          clearInterval(poll);
          UIView.animateWithDurationAnimations(0.6, () => (native.alpha = 0));
          setTimeout(() => {
            if (current === job) stopClip();
            else job.stop();
            onEnded?.();
          }, 650);
        }
      }, 200);
    },
    () => {
      if (!cancelled) onEnded?.();
    },
  );
  // Gone from the screen (another page, another tab): the clip stops with it.
  const gone = () => {
    if (current === job) stopClip();
  };
  host.once("unloaded", gone);
  const plainStop = job.stop;
  job.stop = () => {
    host.off("unloaded", gone);
    plainStop();
  };
  // The caller's handle stops this clip only (not one another screen started since).
  return {
    stop: () => {
      if (current === job) stopClip();
      else job.stop();
    },
  };
}
