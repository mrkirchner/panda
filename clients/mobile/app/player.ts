// Playing on the phone: the server plans the stream for this device (profile.ts), and
// AVPlayerViewController plays it full screen with iOS's own controls, AirPlay and Picture in
// Picture. Progress goes to the server every few seconds and when the player closes, as on the
// TV (resume and Continue Watching work across devices).
import { Utils } from "@nativescript/core";
import { absolute, api } from "@tv/api/client";
import type { Playback } from "@tv/api/types";
import { phoneProfile } from "./profile";

/** How often progress is saved while playing. */
const SAVE_EVERY_MS = 10_000;

export type PlayTarget = { kind: "title"; id: string } | { kind: "item"; id: number };

let audioSessionReady = false;
function readyAudioSession() {
  if (audioSessionReady) return;
  // Sound plays with the ringer switch on silent, and keeps playing in Picture in Picture.
  const session = AVAudioSession.sharedInstance();
  session.setCategoryModeOptionsError(AVAudioSessionCategoryPlayback, AVAudioSessionModeMoviePlayback, 0 as AVAudioSessionCategoryOptions);
  session.setActiveError(true);
  audioSessionReady = true;
}

function topController(): UIViewController | null {
  let vc = Utils.ios.getRootViewController() as UIViewController | null;
  while (vc?.presentedViewController) vc = vc.presentedViewController;
  return vc;
}

const seconds = (t: CMTime) => {
  const s = CMTimeGetSeconds(t);
  return Number.isFinite(s) ? s : NaN;
};

/** Start playing `target` from `startSecs` (its saved position, or 0). Rejects if the server says no. */
export async function play(target: PlayTarget, startSecs = 0): Promise<void> {
  const profile = phoneProfile();
  const pb: Playback =
    target.kind === "title"
      ? await api.playTitle(target.id, profile, startSecs)
      : await api.startPlayback(target.id, profile, startSecs);

  readyAudioSession();
  const item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(absolute(pb.url)));
  const player = AVPlayer.playerWithPlayerItem(item);
  const controller = AVPlayerViewController.new();
  controller.player = player;
  controller.allowsPictureInPicturePlayback = true;
  controller.modalPresentationStyle = UIModalPresentationStyle.FullScreen;

  // HLS: the stream starts at the asked time (its timeline at 0). A direct file seeks there.
  const offset = pb.method === "hls" ? pb.start_secs : 0;
  if (pb.method === "direct_play" && startSecs > 0) {
    player.seekToTimeToleranceBeforeToleranceAfter(CMTimeMakeWithSeconds(startSecs, 600), kCMTimeZero, kCMTimeZero);
  }

  const position = () => {
    const t = seconds(player.currentTime());
    return Number.isFinite(t) ? t + offset : startSecs;
  };
  const duration = () => {
    const d = seconds(item.duration);
    return Number.isFinite(d) && d > 0 ? d + offset : undefined;
  };
  const save = () => api.progress(pb.item_id, position(), duration()).catch(() => {});

  let shown = false;
  const timer = setInterval(() => {
    // Closed (Done, or swiped down): save where it got to and end the server's session.
    if (shown && !controller.presentingViewController && !controller.viewIfLoaded?.window) {
      clearInterval(timer);
      clearInterval(saver);
      void save();
      player.pause();
      player.replaceCurrentItemWithPlayerItem(null);
      if (pb.method === "hls") void api.stopSession(pb.session_id);
    }
  }, 1000);
  const saver = setInterval(() => {
    if (player.rate !== 0) void save();
  }, SAVE_EVERY_MS);

  topController()?.presentViewControllerAnimatedCompletion(controller, true, () => {
    shown = true;
    player.play();
  });
}
