// Playing on the phone: the server plans the stream for this device (profile.ts), and
// AVPlayerViewController plays it full screen with iOS's own controls, AirPlay and Picture in
// Picture. Over the video: subtitles (subtitles.ts) and, on a tap, an "Audio and subtitles"
// button (iOS's player has no place for our own menus). Progress goes to the server every few
// seconds and when the player closes, as on the TV (resume and Continue Watching follow you).
import { ImageSource, Utils } from "@nativescript/core";
import { absolute, api } from "@tv/api/client";
import type { AudioTrack, Playback, SubtitleTrack } from "@tv/api/types";
import { t } from "@tv/i18n";
import { audioLabels } from "@tv/playback/audio";
import { trackLabels } from "@tv/playback/subtitles";
import { phoneProfile } from "./profile";
import { SubtitleSource, initialTrack, rememberSubtitles, type Showing } from "./subtitles";

/** How often progress is saved while playing. */
const SAVE_EVERY_MS = 10_000;
/** The Audio and subtitles button hides this long after the last tap. */
const BUTTON_MS = 4000;

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

const seconds = (time: CMTime) => {
  const s = CMTimeGetSeconds(time);
  return Number.isFinite(s) ? s : NaN;
};

// ---- Objective-C glue: a target for buttons and gestures, and a gesture delegate that lets
// iOS's own controls see the same taps ----

type Fn = () => void;
const Target = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject & { fn?: Fn } };
}).extend(
  {
    run(this: { fn?: Fn }) {
      this.fn?.();
    },
  },
  { exposedMethods: { run: { returns: interop.types.void, params: [] } } },
);
const objcTarget = (fn: Fn) => {
  const o = new Target();
  o.fn = fn;
  return o;
};
const Simultaneous = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject };
}).extend(
  {
    gestureRecognizerShouldRecognizeSimultaneouslyWithGestureRecognizer() {
      return true;
    },
  },
  { protocols: [UIGestureRecognizerDelegate] },
);

/** "Your audio track for this title", remembered on this phone (the TV's key). */
const audioKey = (target: PlayTarget) => `panda.audio.${target.kind}.${target.id}`;
function savedAudio(target: PlayTarget): number | undefined {
  try {
    const v = localStorage.getItem(audioKey(target));
    return v === null ? undefined : Number(v);
  } catch {
    return undefined;
  }
}

async function request(target: PlayTarget, at: number, audioIndex?: number): Promise<Playback> {
  const profile = phoneProfile();
  return target.kind === "title"
    ? api.playTitle(target.id, profile, at, undefined, audioIndex)
    : api.startPlayback(target.id, profile, at, audioIndex);
}

/** Start playing `target` from `startSecs` (its saved position, or 0). Rejects if the server says no. */
export async function play(target: PlayTarget, startSecs = 0): Promise<void> {
  let pb = await request(target, startSecs, savedAudio(target));
  readyAudioSession();

  const player = AVPlayer.new();
  const controller = AVPlayerViewController.new();
  controller.player = player;
  controller.allowsPictureInPicturePlayback = true;
  controller.modalPresentationStyle = UIModalPresentationStyle.FullScreen;
  const keep: NSObject[] = []; // targets and delegates live as long as the player

  // HLS starts at the asked time (its timeline at 0); a direct file seeks there.
  let offset = 0;
  let item: AVPlayerItem;
  const load = (p: Playback, at: number) => {
    item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(absolute(p.url)));
    player.replaceCurrentItemWithPlayerItem(item);
    offset = p.method === "hls" ? p.start_secs : 0;
    if (p.method === "direct_play" && at > 0) {
      player.seekToTimeToleranceBeforeToleranceAfter(CMTimeMakeWithSeconds(at, 600), kCMTimeZero, kCMTimeZero);
    }
  };
  load(pb, startSecs);

  const position = () => {
    const s = seconds(player.currentTime());
    return Number.isFinite(s) ? s + offset : startSecs;
  };
  const duration = () => {
    const d = seconds(item.duration);
    return Number.isFinite(d) && d > 0 ? d + offset : undefined;
  };
  const save = () => api.progress(pb.item_id, position(), duration()).catch(() => {});

  // ---- Subtitles, drawn over the video ----
  const overlay = controller.contentOverlayView as UIView;
  const label = UILabel.new();
  label.numberOfLines = 0;
  label.textAlignment = NSTextAlignment.Center;
  label.textColor = UIColor.whiteColor;
  label.layer.shadowColor = UIColor.blackColor.CGColor;
  label.layer.shadowOpacity = 1;
  label.layer.shadowRadius = 3;
  label.layer.shadowOffset = CGSizeMake(0, 1);
  overlay.addSubview(label);
  let images: UIImageView[] = [];
  const imageCache = new Map<string, UIImage | null>();
  let subs: SubtitleSource | null = null;
  let shownKey = "";

  let drawnWidth = 0;
  const draw = (s: Showing) => {
    const key = !s ? "" : s.kind === "text" ? `t:${s.text}` : `b:${s.cue.start}`;
    const box = overlay.bounds.size;
    // Rotated: everything is placed again.
    if (box.width !== drawnWidth) {
      drawnWidth = box.width;
      shownKey = "x";
    }
    if (key === shownKey && s?.kind !== "text") return;
    shownKey = key;
    // The picture's rectangle (letterboxed in portrait); the whole view until it's known.
    const v = controller.videoBounds;
    const pic = v.size.width > 0 ? v : CGRectMake(0, 0, box.width, box.height);
    // Text: centered near the bottom of the picture, sized to it.
    if (s?.kind === "text") {
      label.font = UIFont.boldSystemFontOfSize(Math.max(14, Math.min(pic.size.width * 0.045, 30)));
      label.text = s.text;
      const width = pic.size.width - 32;
      const fit = label.sizeThatFits(CGSizeMake(width, box.height));
      const bottom = pic.origin.y + pic.size.height - pic.size.height * 0.06;
      label.frame = CGRectMake(pic.origin.x + 16, bottom - fit.height, width, fit.height);
      label.hidden = false;
    } else {
      label.hidden = true;
    }
    // Images: where they were authored, on the picture.
    for (const v of images) v.removeFromSuperview();
    images = [];
    if (s?.kind === "bitmap") {
      const video = pic;
      const sx = video.size.width / (s.frame.video_width || 1920);
      const sy = video.size.height / (s.frame.video_height || 1080);
      for (const img of s.cue.images) {
        const view = UIImageView.alloc().initWithFrame(
          CGRectMake(video.origin.x + img.x * sx, video.origin.y + img.y * sy, img.width * sx, img.height * sy),
        );
        view.contentMode = UIViewContentMode.ScaleAspectFit;
        const url = absolute(img.url);
        const cached = imageCache.get(url);
        if (cached) view.image = cached;
        else if (cached === undefined) {
          imageCache.set(url, null);
          ImageSource.fromUrl(url).then(
            src => {
              imageCache.set(url, src.ios as UIImage);
              shownKey = ""; // draw again with the picture
            },
            () => imageCache.delete(url),
          );
        }
        overlay.addSubview(view);
        images.push(view);
      }
    }
  };
  const showSubs = () => draw(subs ? subs.at(position()) : null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const chooseSubs = (track: SubtitleTrack | null) => {
    subs?.close();
    subs = track ? new SubtitleSource(track, showSubs, () => toast(t("These subtitles couldn't be loaded"))) : null;
    shownKey = "x";
    showSubs();
  };
  const audioLanguage = () => pb.audio?.find(a => a.index === pb.audio_index)?.language ?? null;
  chooseSubs(initialTrack(pb.subtitles, audioLanguage()));

  // ---- The Audio and subtitles button: shows on a tap, with iOS's controls ----
  const button = UIButton.buttonWithType(UIButtonType.System);
  button.setImageForState(UIImage.systemImageNamed("captions.bubble"), UIControlState.Normal);
  button.tintColor = UIColor.whiteColor;
  button.backgroundColor = UIColor.colorWithWhiteAlpha(0, 0.45);
  button.layer.cornerRadius = 22;
  button.alpha = 0;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hasChoice = () => pb.subtitles.some(s => s.url) || (pb.audio?.length ?? 0) > 1;
  const showButton = () => {
    if (!hasChoice()) return;
    const view = controller.view;
    const inset = view.safeAreaInsets;
    button.frame = CGRectMake(view.bounds.size.width - inset.right - 64, inset.top + 64, 44, 44);
    UIView.animateWithDurationAnimations(0.2, () => (button.alpha = 1));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => UIView.animateWithDurationAnimations(0.3, () => (button.alpha = 0)), BUTTON_MS);
  };
  const tapTarget = objcTarget(showButton);
  const tap = UITapGestureRecognizer.alloc().initWithTargetAction(tapTarget, "run");
  tap.cancelsTouchesInView = false;
  const simultaneous = new Simultaneous();
  tap.delegate = simultaneous as unknown as UIGestureRecognizerDelegate;
  const menuTarget = objcTarget(() => openMenu());
  button.addTargetActionForControlEvents(menuTarget, "run", UIControlEvents.TouchUpInside);
  keep.push(tapTarget, simultaneous, menuTarget);

  const toastLabel = UILabel.new();
  toastLabel.textColor = UIColor.whiteColor;
  toastLabel.backgroundColor = UIColor.colorWithWhiteAlpha(0, 0.6);
  toastLabel.textAlignment = NSTextAlignment.Center;
  toastLabel.layer.cornerRadius = 10;
  toastLabel.clipsToBounds = true;
  toastLabel.alpha = 0;
  const toast = (text: string) => {
    const view = controller.view;
    toastLabel.text = `  ${text}  `;
    toastLabel.sizeToFit();
    const w = toastLabel.frame.size.width + 16;
    toastLabel.frame = CGRectMake((view.bounds.size.width - w) / 2, view.safeAreaInsets.top + 70, w, 36);
    toastLabel.alpha = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => UIView.animateWithDurationAnimations(0.3, () => (toastLabel.alpha = 0)), 2000);
  };

  const sheet = (title: string, options: { label: string; selected: boolean; pick: () => void }[]) => {
    const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
      title,
      null,
      UIAlertControllerStyle.ActionSheet,
    );
    for (const o of options) {
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler(`${o.selected ? "✓ " : ""}${o.label}`, UIAlertActionStyle.Default, o.pick),
      );
    }
    alert.addAction(UIAlertAction.actionWithTitleStyleHandler(t("Cancel"), UIAlertActionStyle.Cancel, () => {}));
    const pop = alert.popoverPresentationController;
    if (pop) {
      pop.sourceView = button;
      pop.sourceRect = button.bounds;
    }
    controller.presentViewControllerAnimatedCompletion(alert, true, () => {});
  };

  const subtitleMenu = () => {
    const tracks = pb.subtitles.filter(s => s.url);
    const labels = trackLabels(tracks);
    sheet(t("Subtitles"), [
      {
        label: t("Off"),
        selected: !subs,
        pick: () => {
          chooseSubs(null);
          rememberSubtitles(null);
        },
      },
      ...tracks.map((track, i) => ({
        label: labels[i],
        selected: subs?.track.key === track.key,
        pick: () => {
          chooseSubs(track);
          rememberSubtitles(track);
        },
      })),
    ]);
  };

  /** Another audio track: the server starts again there with it (copied, or converted). */
  const switchAudio = async (a: AudioTrack) => {
    const at = position();
    const was = pb;
    try {
      pb = await request(target, at, a.index);
    } catch (e) {
      toast(String(e));
      return;
    }
    try {
      localStorage.setItem(audioKey(target), String(a.index));
    } catch {
      // Not remembered without storage.
    }
    load(pb, at);
    player.play();
    if (was.method === "hls") void api.stopSession(was.session_id);
  };

  const audioMenu = () => {
    const tracks = pb.audio ?? [];
    const labels = audioLabels(tracks);
    sheet(
      t("Audio"),
      tracks.map((a, i) => ({
        label: labels[i],
        selected: a.index === pb.audio_index,
        pick: () => void switchAudio(a),
      })),
    );
  };

  const openMenu = () => {
    clearTimeout(hideTimer);
    const audio = (pb.audio?.length ?? 0) > 1;
    const text = pb.subtitles.some(s => s.url);
    if (audio && text) {
      sheet(t("Audio and subtitles"), [
        { label: t("Subtitles"), selected: false, pick: subtitleMenu },
        { label: t("Audio"), selected: false, pick: audioMenu },
      ]);
    } else if (audio) audioMenu();
    else subtitleMenu();
  };

  // ---- Running ----
  const observer = player.addPeriodicTimeObserverForIntervalQueueUsingBlock(
    CMTimeMakeWithSeconds(0.1, 600),
    null,
    () => showSubs(),
  );

  let shown = false;
  const timer = setInterval(() => {
    // Closed (Done, or swiped down): save where it got to and end the server's session.
    if (shown && !controller.presentingViewController && !controller.viewIfLoaded?.window) {
      clearInterval(timer);
      clearInterval(saver);
      clearTimeout(hideTimer);
      void save();
      subs?.close();
      player.removeTimeObserver(observer);
      player.pause();
      player.replaceCurrentItemWithPlayerItem(null);
      keep.length = 0;
      if (pb.method === "hls") void api.stopSession(pb.session_id);
    }
  }, 1000);
  const saver = setInterval(() => {
    if (player.rate !== 0) void save();
  }, SAVE_EVERY_MS);

  topController()?.presentViewControllerAnimatedCompletion(controller, true, () => {
    shown = true;
    controller.view.addGestureRecognizer(tap);
    controller.view.addSubview(button);
    controller.view.addSubview(toastLabel);
    player.play();
    showButton();
  });
}
