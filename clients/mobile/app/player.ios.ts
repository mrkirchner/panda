// Playing on the phone, with our own controls (as the TV has): iOS's player would read a
// stream the server is still converting as a live broadcast ("LIVE", no running time, no
// seeking past what's converted). Here the timeline is the whole file (its duration from the
// server), and a seek outside what this stream has starts a new one right there
// (`planSeek`, the TV's). AVPlayer still plays the video, with AirPlay and Picture in Picture.
//
// On screen: Close, the title, AirPlay and Picture in Picture on top; back 10 s, play/pause and
// forward 10 s in the middle; the scrubber (with the server's preview frames while dragging),
// the times, and Subtitles, Audio and Quality at the bottom. A tap shows or hides them; they
// hide by themselves while playing. Progress goes to the server every few seconds and when
// the player closes, so resume and Continue Watching follow you between the phone and the TVs.
//
// In the background (locked, or another app) the sound keeps playing, or the picture goes to
// Picture in Picture; the lock screen and Control Center show it with play/pause, skip and the
// scrubber (Now Playing).
import { Application, ImageSource, Utils } from "@nativescript/core";
import { absolute, api, HttpError, imageUrl } from "@tv/api/client";
import type { AudioTrack, Item, Markers, Playback, SubtitleTrack } from "@tv/api/types";
import {
  beforeUpNext,
  countdownAllowed,
  inIntro,
  MARKER_RETRY_SECS,
  nextLabel,
  noteAutoplay,
  noteInteraction,
  upNext,
} from "@tv/playback/skips";
import { formatTime } from "@tv/format";
import { lang, t } from "@tv/i18n";
import { languageName } from "@tv/format";
import { DEFAULT_STALLS, StallMonitor, stepDownBudget } from "@tv/playback/stalls";
import { features } from "./features";
import { audioLabels } from "@tv/playback/audio";
import { QUALITIES, describeStream, profileFor, saveQuality, savedQuality, type QualityId } from "@tv/playback/quality";
import { planSeek } from "@tv/playback/seek";
import {
  clampTiming,
  describeTiming,
  saveTiming,
  savedTiming,
  shortTiming,
  trackLabels,
} from "@tv/playback/subtitles";
import { previewUrl } from "@tv/playback/trickplay";
import { phoneProfile } from "./profile.ios";
import { setPlayerOpen } from "./clip.ios";
import { SubtitleSource, initialTrack, rememberSubtitles, type Showing } from "./subtitles";
import { audioChoice, read, write } from "@tv/platform/settings";
import type { PlayTarget } from "./platformTypes";
import { nowPlaying } from "./nowPlaying.ios";
import { nowPlayingInfo, type NowPlayingSession } from "@tv/platform/types";

/** How often progress is saved while playing. */
const SAVE_EVERY_MS = 10_000;
/** The controls hide this long after the last touch while playing. */
const CONTROLS_HIDE_MS = 4000;
/** The server deletes segments 120 s behind the viewer; seeking further back restarts. */
const KEEP_BEHIND_SECS = 90;
/** The scrub preview follows the thumb once it's held still this long (fewer requests). */
const PREVIEW_SETTLE_MS = 150;
const SKIP_SECS = 10;

/** A movie (`version`: one of its files, else the server picks) or one file (an episode). */

const seconds = (time: CMTime) => {
  const s = CMTimeGetSeconds(time);
  return Number.isFinite(s) ? s : NaN;
};

function topController(): UIViewController | null {
  let vc = Utils.ios.getRootViewController() as UIViewController | null;
  while (vc?.presentedViewController) vc = vc.presentedViewController;
  return vc;
}

function readyAudioSession() {
  // Sound plays with the ringer switch on silent, and keeps playing in Picture in Picture.
  const session = AVAudioSession.sharedInstance();
  session.setCategoryModeOptionsError(
    AVAudioSessionCategoryPlayback,
    AVAudioSessionModeMoviePlayback,
    0 as AVAudioSessionCategoryOptions,
  );
  session.setActiveError(true);
}

/** The player closed: give the sound back (others' music resumes) and let clips mix quietly. */
function releaseAudioSession() {
  const session = AVAudioSession.sharedInstance();
  session.setActiveWithOptionsError(false, AVAudioSessionSetActiveOptions.NotifyOthersOnDeactivation);
  session.setCategoryModeOptionsError(AVAudioSessionCategoryAmbient, AVAudioSessionModeDefault, 0 as AVAudioSessionCategoryOptions);
}

/** Decoded image-subtitle pictures kept (the one showing and a few around it). */
const SUB_IMAGES_KEPT = 8;

// ---- Objective-C glue ----

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

/** The player's screen: landscape on a phone, no status bar, and our layout on every resize. */
const PlayerController = (UIViewController as unknown as {
  extend(methods: object): { new (): UIViewController & { onLayout?: Fn } };
}).extend({
  viewDidLayoutSubviews(this: UIViewController & { onLayout?: Fn }) {
    this.onLayout?.();
  },
  get supportedInterfaceOrientations() {
    return UIDevice.currentDevice.userInterfaceIdiom === UIUserInterfaceIdiom.Pad
      ? UIInterfaceOrientationMask.All
      : UIInterfaceOrientationMask.Landscape;
  },
  get preferredInterfaceOrientationForPresentation() {
    return UIInterfaceOrientation.LandscapeRight;
  },
  get prefersStatusBarHidden() {
    return true;
  },
  get prefersHomeIndicatorAutoHidden() {
    return true;
  },
});

function symbolButton(name: string, size: number): UIButton {
  const b = UIButton.buttonWithType(UIButtonType.System);
  const config = UIImageSymbolConfiguration.configurationWithPointSize(size);
  b.setImageForState(UIImage.systemImageNamedWithConfiguration(name, config), UIControlState.Normal);
  b.tintColor = UIColor.whiteColor;
  return b;
}

function textLabel(size: number, bold = false): UILabel {
  const l = UILabel.new();
  l.textColor = UIColor.whiteColor;
  l.font = bold ? UIFont.boldSystemFontOfSize(size) : UIFont.monospacedDigitSystemFontOfSizeWeight(size, 0);
  return l;
}

/** Start playing `target` from `startSecs` (its saved position, or 0). Rejects if the server says no. */
/** `onClose`: after the player closes (Continue Watching lands on the title's page, as on the TV). */
export async function play(target: PlayTarget, startSecs = 0, onClose?: () => void): Promise<void> {
  const p = new PlayerSession(target, onClose);
  current = p;
  await p.open(startSecs);
}

let current: PlayerSession | null = null;
/** Debug builds (devLaunch.tsx `-pandaSeek`): seek the open player as its scrubber would. */
export const devSeek = (secs: number) => current?.devSeek(secs);

class PlayerSession {
  private pb!: Playback;
  private info: Item | null = null;
  private readonly player = AVPlayer.new();
  private item: AVPlayerItem | null = null;
  /** Where this stream starts in the file (HLS timelines begin at 0 there). */
  private offset = 0;
  /** While a new stream is being asked for: where it will start. */
  private pending: number | null = null;
  private quality: QualityId = savedQuality();
  private audioIndex: number | undefined;
  private subs: SubtitleSource | null = null;
  /** Seconds the subtitles are shown later (+) or earlier (-), per file and track (the TV's). */
  private timing = 0;
  private closed = false;
  private readonly keep: NSObject[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private observer: unknown = null;
  /** The lock screen and Control Center (nowPlaying.ios.ts). */
  private nowPlaying: NowPlayingSession | null = null;
  private readonly appEvents: [string, (...a: unknown[]) => void][] = [];
  /** The TV's stall rules: too many or too long, and the stream steps down a quality. */
  private readonly stalls = new StallMonitor();
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private waiting = false;
  /** This session's bitrate cap from step-downs (the saved quality choice is untouched). */
  private stallCap: number | null = null;
  /** Restarts after a broken stream in the last minute (a few, then it stops and says why). */
  private retries: number[] = [];
  private canSearchSubs = false;
  private finding = false;
  /** Skip intro and Up next (the TV's rules, @tv/playback/skips). */
  private markers: Markers | undefined;
  private upNextDismissed = false;
  /** Set when the next episode takes this player's place (opened once this one has closed). */
  private nextTarget: PlayTarget | null = null;
  private stillShown: string | null = null;

  // Views
  private readonly vc = new PlayerController();
  private readonly layer = AVPlayerLayer.playerLayerWithPlayer(this.player);
  private readonly videoView = UIView.new();
  private readonly subsView = UIView.new();
  private readonly subLabel = UILabel.new();
  private subImages: UIImageView[] = [];
  private readonly imageCache = new Map<string, UIImage | null>();
  private shownKey = "";
  private drawnWidth = 0;
  private readonly controls = UIView.new();
  private readonly closeButton = symbolButton("xmark", 20);
  private readonly titleLabel = textLabel(16, true);
  /** "Auto · 1080p HEVC 2.4 Mbps (videotoolbox)": the quality chosen and what's streaming. */
  private readonly streamLabel = textLabel(12);
  private readonly route = AVRoutePickerView.new();
  private readonly pipButton = symbolButton("pip.enter", 20);
  private readonly backButton = symbolButton("gobackward.10", 30);
  private readonly playButton = symbolButton("pause.fill", 44);
  private readonly forwardButton = symbolButton("goforward.10", 30);
  private readonly slider = UISlider.new();
  private readonly timeLabel = textLabel(13);
  private readonly remainLabel = textLabel(13);
  private readonly subsButton = symbolButton("captions.bubble", 20);
  private readonly audioButton = symbolButton("waveform", 20);
  private readonly qualityButton = symbolButton("gearshape", 20);
  private readonly preview = UIImageView.new();
  private readonly previewLabel = textLabel(13, true);
  private readonly spinner = UIActivityIndicatorView.alloc().initWithActivityIndicatorStyle(
    UIActivityIndicatorViewStyle.Large,
  );
  private readonly toastLabel = UILabel.new();
  private pip: AVPictureInPictureController | null = null;
  private readonly skipButton = UIButton.buttonWithType(UIButtonType.System);
  private readonly upNextCard = UIView.new();
  private readonly upNextImage = UIImageView.new();
  private readonly upNextHeading = textLabel(13);
  private readonly upNextName = textLabel(15, true);
  private readonly creditsButton = UIButton.buttonWithType(UIButtonType.System);
  private readonly nextButton = UIButton.buttonWithType(UIButtonType.System);

  constructor(
    private readonly target: PlayTarget,
    private readonly onClose?: () => void,
  ) {
    const saved = this.savedAudio();
    this.audioIndex = saved;
  }

  // ---- Streams ----

  private async request(at: number): Promise<Playback> {
    const chosen = await profileFor(phoneProfile(), this.quality);
    const profile =
      this.stallCap === null
        ? chosen
        : { ...chosen, max_bitrate_kbps: Math.min(chosen.max_bitrate_kbps ?? Infinity, this.stallCap) };
    const target = this.target;
    try {
      return target.kind === "title"
        ? await api.playTitle(target.id, profile, at, target.version, this.audioIndex)
        : await api.startPlayback(target.id, profile, at, this.audioIndex);
    } catch (e) {
      // 503: the library's storage (NAS) is offline; said plainly.
      if (e instanceof HttpError && e.status === 503) {
        throw new Error(t("This title's storage isn't reachable right now. Check that the NAS is on and connected."));
      }
      throw e;
    }
  }

  private load(pb: Playback, at: number) {
    this.pb = pb;
    this.markers = pb.markers;
    this.item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(absolute(pb.url)));
    this.player.replaceCurrentItemWithPlayerItem(this.item);
    this.offset = pb.method === "hls" ? pb.start_secs : 0;
    this.stalls.reset(Date.now());
    if (pb.method === "direct_play" && at > 0) {
      this.player.seekToTimeToleranceBeforeToleranceAfter(CMTimeMakeWithSeconds(at, 600), kCMTimeZero, kCMTimeZero);
    }
  }

  /** Start again at `at` (a seek outside this stream, another audio track or quality). */
  private async restart(at: number) {
    if (this.pending !== null) return;
    const was = this.pb;
    this.pending = at;
    this.player.pause();
    this.spinner.startAnimating();
    try {
      const pb = await this.request(at);
      if (this.closed) {
        if (pb.method === "hls") void api.stopSession(pb.session_id);
        return;
      }
      this.load(pb, at);
      // The same subtitle track again, with this stream's (newly signed) address.
      const key = this.subs?.track.key;
      this.chooseSubs(key ? (pb.subtitles.find(s => s.key === key) ?? null) : null, false);
      this.player.play();
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
    } finally {
      this.pending = null;
    }
    if (was.method === "hls") void api.stopSession(was.session_id);
  }

  /** Seconds into the file. */
  private position(): number {
    if (this.pending !== null) return this.pending;
    const s = seconds(this.player.currentTime());
    return Number.isFinite(s) ? s + this.offset : this.offset;
  }

  /** The whole file's length: the server's, else what the stream says. */
  private duration(): number {
    const known = this.info?.duration_secs;
    if (known) return known;
    const d = this.item ? seconds(this.item.duration) : NaN;
    return Number.isFinite(d) ? d + this.offset : 0;
  }

  /** End (file time) of what this stream can play right now. */
  private availableEnd(): number {
    const ranges = this.item?.seekableTimeRanges;
    if (!ranges || ranges.count === 0) return this.offset;
    const r = (ranges.lastObject as NSValue).CMTimeRangeValue;
    return this.offset + seconds(r.start) + seconds(r.duration);
  }

  private seekTo(target: number) {
    const dur = this.duration();
    const to = Math.max(0, dur > 0 ? Math.min(target, dur - 1) : target);
    const action = planSeek(to, {
      method: this.pb.method,
      offset: this.offset,
      availableEnd: this.availableEnd(),
      current: this.position(),
      keepBehind: KEEP_BEHIND_SECS,
    });
    this.stalls.reset(Date.now());
    if (action.kind === "jump") {
      this.player.seekToTimeToleranceBeforeToleranceAfter(
        CMTimeMakeWithSeconds(action.mediaTime, 600),
        kCMTimeZero,
        kCMTimeZero,
      );
    } else {
      void this.restart(action.at);
    }
    this.showSubs(true);
  }

  devSeek(secs: number) {
    this.seekTo(secs);
    this.showControls();
  }

  private save() {
    return api.progress(this.pb.item_id, this.position(), this.duration() || undefined).catch(() => {});
  }

  // ---- Opening and closing ----

  async open(startSecs: number) {
    setPlayerOpen(true);
    try {
      this.load(await this.request(startSecs), startSecs);
    } catch (e) {
      setPlayerOpen(false);
      throw e;
    }
    readyAudioSession();
    api.item(this.pb.item_id).then(
      i => {
        this.info = i;
        this.titleLabel.text =
          i.kind === "episode"
            ? `${i.series ?? ""}  S${i.season ?? 0}:E${i.episode ?? 0}  ${i.episode_title ?? ""}`.trim()
            : (i.meta_title ?? i.title);
        this.updateNowPlaying();
      },
      () => {},
    );
    this.build();
    this.chooseSubs(initialTrack(this.pb.subtitles, this.audioLanguage()), false);
    void features().then(f => (this.canSearchSubs = !!f?.subtitle_search));
    this.vc.modalPresentationStyle = UIModalPresentationStyle.FullScreen;
    topController()?.presentViewControllerAnimatedCompletion(this.vc, true, () => {
      this.player.play();
      this.showControls();
    });

    this.observer = this.player.addPeriodicTimeObserverForIntervalQueueUsingBlock(
      CMTimeMakeWithSeconds(0.1, 600),
      null,
      () => this.tick(),
    );
    if (this.pb.markers?.pending) {
      const id = this.pb.item_id;
      for (const secs of MARKER_RETRY_SECS) {
        this.timers.push(
          setTimeout(() => {
            if (this.closed || !this.markers?.pending) return;
            api.markers(id).then(
              m => (this.markers = m),
              () => {},
            );
          }, secs * 1000),
        );
      }
    }
    this.timers.push(
      setInterval(() => {
        if (this.player.rate !== 0) void this.save();
      }, SAVE_EVERY_MS),
      setInterval(() => this.updateNowPlaying(), 1000),
    );
    this.startBackground();
    this.nowPlaying = nowPlaying.start(this.nowPlayingInfo(), {
      play: () => this.player.play(),
      pause: () => this.player.pause(),
      seekTo: secs => this.seekTo(secs),
    });
  }

  // ---- In the background, and on the lock screen ----

  private startBackground() {
    // Leaving the app: the sound goes on without the picture (iOS pauses a player still drawing
    // into a layer), unless Picture in Picture took the picture along.
    const away = () => {
      if (!this.pip?.pictureInPictureActive) this.layer.player = null;
    };
    const back = () => {
      this.layer.player = this.player;
    };
    this.appEvents.push([Application.backgroundEvent, away], [Application.foregroundEvent, back]);
    for (const [name, fn] of this.appEvents) Application.on(name, fn);
  }

  private nowPlayingInfo() {
    const art = this.info ? (this.info.backdrop ?? this.info.poster) : null;
    return nowPlayingInfo(this.info, imageUrl(art) ?? null, this.duration());
  }

  /** What the lock screen and Control Center show: title, show, artwork, where it's at. */
  private updateNowPlaying() {
    if (this.closed || !this.nowPlaying) return;
    this.nowPlaying.setInfo(this.nowPlayingInfo());
    this.nowPlaying.setPosition(this.position(), this.player.rate !== 0);
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    void this.save();
    for (const t of this.timers) clearInterval(t);
    const next = this.nextTarget;
    clearTimeout(this.stallTimer);
    clearTimeout(this.hideTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.previewTimer);
    this.subs?.close();
    if (this.observer) this.player.removeTimeObserver(this.observer);
    for (const [name, fn] of this.appEvents) Application.off(name, fn);
    this.nowPlaying?.end();
    this.pip?.stopPictureInPicture();
    this.player.pause();
    this.player.replaceCurrentItemWithPlayerItem(null);
    if (this.pb.method === "hls") void api.stopSession(this.pb.session_id);
    releaseAudioSession();
    this.imageCache.clear();
    // On to the next episode: this player goes without animating and the next one opens.
    this.vc.dismissViewControllerAnimatedCompletion(!next, () => {
      this.keep.length = 0;
      setPlayerOpen(false);
      if (next) play(next, 0, this.onClose).catch(() => this.onClose?.());
      else this.onClose?.();
    });
  }

  // ---- Every tenth of a second: times, scrubber, subtitles, buttons ----

  private tick() {
    const pos = this.position();
    const dur = this.duration();
    if (!this.slider.tracking) {
      this.slider.maximumValue = Math.max(dur, 1);
      this.slider.value = pos;
      this.timeLabel.text = formatTime(pos);
      this.remainLabel.text = dur > 0 ? `-${formatTime(Math.max(0, dur - pos))}` : "";
    }
    const waiting =
      this.pending !== null ||
      this.player.timeControlStatus === AVPlayerTimeControlStatus.WaitingToPlayAtSpecifiedRate;
    if (waiting) this.spinner.startAnimating();
    else this.spinner.stopAnimating();
    this.watchStalls(waiting && this.pending === null && this.player.rate !== 0);
    if (this.item?.status === AVPlayerItemStatus.Failed && this.pending === null) this.recover();
    this.setPlayIcon();
    this.showSubs();
    this.showSkips(pos, dur);
    // The end: saved as watched (the server marks it finished), then the next episode (unless
    // nobody's been here for a while) or the player closes.
    if (dur > 0 && pos >= dur - 1 && this.player.rate === 0 && this.pending === null) {
      if (this.pb.next && countdownAllowed()) this.playNext(true);
      else this.close();
    }
  }

  /** Skip intro over the intro; Up next at the credits, counting down to the next episode. */
  private showSkips(pos: number, dur: number) {
    const next = this.pb.next ?? null;
    if (this.upNextDismissed && beforeUpNext(this.markers, dur, next, pos)) this.upNextDismissed = false;
    const state = upNext(this.markers, dur, next, pos, this.upNextDismissed);
    this.skipButton.hidden = state.show || !inIntro(this.markers, pos);
    this.upNextCard.hidden = !state.show || !next;
    if (state.show && next) {
      const { heading, name } = nextLabel(next);
      this.upNextHeading.text =
        state.secondsLeft === null
          ? t("Up next")
          : t("Next episode in {secs}", { secs: String(state.secondsLeft) });
      this.upNextName.text = `${heading}  ${name}`.trim();
      const art = imageUrl(next.still ?? next.backdrop ?? null) ?? null;
      if (art && art !== this.stillShown) {
        this.stillShown = art;
        ImageSource.fromUrl(art).then(
          src => (this.upNextImage.image = src.ios as UIImage),
          () => {},
        );
      }
    }
    if (state.go && this.pending === null) this.playNext(true);
  }

  private skipTheIntro() {
    noteInteraction();
    const end = this.markers?.intro_end;
    if (end != null) this.seekTo(end);
    this.skipButton.hidden = true;
  }

  /** The next episode in this player's place (`auto`: the countdown, not a tap). */
  private playNext(auto: boolean) {
    const next = this.pb.next;
    if (!next || this.closed) return;
    if (auto) noteAutoplay();
    else noteInteraction();
    this.nextTarget = { kind: "item", id: next.item_id };
    this.close();
  }

  /** Buffering while playing: the TV's step-down rules (StallMonitor). */
  private watchStalls(waiting: boolean) {
    if (waiting === this.waiting) return;
    this.waiting = waiting;
    if (!waiting) {
      this.stalls.playing();
      clearTimeout(this.stallTimer);
      return;
    }
    if (this.stalls.waiting(Date.now())) return void this.stepDown();
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.stalls.stillWaiting(Date.now())) this.stepDown();
    }, DEFAULT_STALLS.longMs);
  }

  /** The connection can't keep up: start again at ~60% of the current bitrate. */
  private stepDown() {
    const next = stepDownBudget(this.pb.stream.bitrate_kbps);
    if (next === null) return;
    this.stallCap = next;
    this.toast(t("Slow connection: lowering quality to {mbps} Mbps", { mbps: (next / 1000).toFixed(1) }));
    void this.restart(this.position());
  }

  /** The stream broke (a missing segment, the NAS dropping): start again where we are, a few
   * times a minute, then stop and say why. */
  private recover() {
    const now = Date.now();
    this.retries = this.retries.filter(at => now - at < 60_000);
    if (this.retries.length >= 3) {
      this.player.replaceCurrentItemWithPlayerItem(null);
      this.item = null;
      this.toast(t("Playback stopped. Check that the NAS is on and connected, then try again."));
      return;
    }
    this.retries.push(now);
    void this.restart(this.position());
  }

  private setPlayIcon() {
    const playing = this.player.rate !== 0 || this.pending !== null;
    const name = playing ? "pause.fill" : "play.fill";
    if ((this.playButton as unknown as { iconName?: string }).iconName === name) return;
    (this.playButton as unknown as { iconName?: string }).iconName = name;
    const config = UIImageSymbolConfiguration.configurationWithPointSize(44);
    this.playButton.setImageForState(UIImage.systemImageNamedWithConfiguration(name, config), UIControlState.Normal);
  }

  // ---- Building the screen ----

  private build() {
    const view = this.vc.view;
    view.backgroundColor = UIColor.blackColor;
    this.layer.videoGravity = AVLayerVideoGravityResizeAspect;
    this.videoView.layer.addSublayer(this.layer);
    view.addSubview(this.videoView);

    this.subsView.userInteractionEnabled = false;
    this.subLabel.numberOfLines = 0;
    this.subLabel.textAlignment = NSTextAlignment.Center;
    this.subLabel.textColor = UIColor.whiteColor;
    this.subLabel.layer.shadowColor = UIColor.blackColor.CGColor;
    this.subLabel.layer.shadowOpacity = 1;
    this.subLabel.layer.shadowRadius = 3;
    this.subLabel.layer.shadowOffset = CGSizeMake(0, 1);
    this.subsView.addSubview(this.subLabel);
    view.addSubview(this.subsView);

    this.controls.backgroundColor = UIColor.colorWithWhiteAlpha(0, 0.4);
    for (const v of [
      this.closeButton,
      this.titleLabel,
      this.streamLabel,
      this.route,
      this.pipButton,
      this.backButton,
      this.playButton,
      this.forwardButton,
      this.slider,
      this.timeLabel,
      this.remainLabel,
      this.subsButton,
      this.audioButton,
      this.qualityButton,
    ]) {
      this.controls.addSubview(v);
    }
    this.route.tintColor = UIColor.whiteColor;
    this.route.activeTintColor = UIColor.colorWithRedGreenBlueAlpha(0.83, 0.68, 0.42, 1);
    this.remainLabel.textAlignment = NSTextAlignment.Right;
    this.slider.minimumTrackTintColor = UIColor.colorWithRedGreenBlueAlpha(0.83, 0.68, 0.42, 1);
    this.slider.maximumTrackTintColor = UIColor.colorWithWhiteAlpha(1, 0.3);
    const thumb = UIImage.systemImageNamedWithConfiguration(
      "circle.fill",
      UIImageSymbolConfiguration.configurationWithPointSize(14),
    );
    if (thumb) {
      this.slider.setThumbImageForState(
        thumb.imageWithTintColorRenderingMode(UIColor.whiteColor, UIImageRenderingMode.AlwaysOriginal),
        UIControlState.Normal,
      );
    }
    view.addSubview(this.controls);

    this.preview.contentMode = UIViewContentMode.ScaleAspectFill;
    this.preview.clipsToBounds = true;
    this.preview.layer.cornerRadius = 6;
    this.preview.backgroundColor = UIColor.colorWithWhiteAlpha(0.1, 1);
    this.preview.hidden = true;
    this.previewLabel.textAlignment = NSTextAlignment.Center;
    this.previewLabel.hidden = true;
    view.addSubview(this.preview);
    view.addSubview(this.previewLabel);

    this.spinner.color = UIColor.whiteColor;
    this.spinner.hidesWhenStopped = true;
    view.addSubview(this.spinner);

    this.toastLabel.textColor = UIColor.whiteColor;
    this.toastLabel.backgroundColor = UIColor.colorWithWhiteAlpha(0, 0.7);
    this.toastLabel.textAlignment = NSTextAlignment.Center;
    this.toastLabel.layer.cornerRadius = 10;
    this.toastLabel.clipsToBounds = true;
    this.toastLabel.alpha = 0;
    view.addSubview(this.toastLabel);

    // Skip intro and Up next: over the picture, above the controls (shown or not).
    const gold = UIColor.colorWithRedGreenBlueAlpha(0.83, 0.68, 0.42, 1);
    const ink = UIColor.colorWithRedGreenBlueAlpha(0.08, 0.07, 0.06, 1);
    const pill = (b: UIButton, title: string, fill: UIColor, color: UIColor) => {
      b.setTitleForState(title, UIControlState.Normal);
      b.setTitleColorForState(color, UIControlState.Normal);
      if (b.titleLabel) b.titleLabel.font = UIFont.boldSystemFontOfSize(15);
      b.backgroundColor = fill;
      b.layer.cornerRadius = 10;
    };
    pill(this.skipButton, t("Skip intro"), UIColor.colorWithRedGreenBlueAlpha(0.96, 0.95, 0.92, 1), ink);
    pill(this.creditsButton, t("Watch credits"), UIColor.colorWithWhiteAlpha(1, 0.16), UIColor.whiteColor);
    pill(this.nextButton, t("Play next episode"), gold, ink);
    this.skipButton.hidden = true;
    view.addSubview(this.skipButton);
    this.upNextCard.backgroundColor = UIColor.colorWithRedGreenBlueAlpha(0.1, 0.1, 0.11, 0.94);
    this.upNextCard.layer.cornerRadius = 14;
    this.upNextCard.clipsToBounds = true;
    this.upNextCard.hidden = true;
    this.upNextImage.contentMode = UIViewContentMode.ScaleAspectFill;
    this.upNextImage.clipsToBounds = true;
    this.upNextImage.layer.cornerRadius = 8;
    this.upNextImage.backgroundColor = UIColor.colorWithWhiteAlpha(0.2, 1);
    this.upNextHeading.textColor = UIColor.colorWithWhiteAlpha(1, 0.65);
    this.upNextName.numberOfLines = 2;
    for (const v of [this.upNextImage, this.upNextHeading, this.upNextName, this.creditsButton, this.nextButton]) {
      this.upNextCard.addSubview(v);
    }
    view.addSubview(this.upNextCard);

    // Picture in Picture: from the button, and on its own when you leave the app while playing.
    if (AVPictureInPictureController.isPictureInPictureSupported()) {
      this.pip = AVPictureInPictureController.alloc().initWithPlayerLayer(this.layer);
      this.pip.canStartPictureInPictureAutomaticallyFromInline = true;
    } else {
      this.pipButton.hidden = true;
    }

    const on = (control: UIControl, events: UIControlEvents, fn: Fn) => {
      const target = new Target();
      target.fn = fn;
      this.keep.push(target);
      control.addTargetActionForControlEvents(target, "run", events);
    };
    on(this.closeButton, UIControlEvents.TouchUpInside, () => this.close());
    on(this.pipButton, UIControlEvents.TouchUpInside, () => {
      if (this.pip?.pictureInPictureActive) this.pip.stopPictureInPicture();
      else this.pip?.startPictureInPicture();
    });
    on(this.playButton, UIControlEvents.TouchUpInside, () => {
      if (this.player.rate !== 0) this.player.pause();
      else this.player.play();
      this.showControls();
    });
    on(this.backButton, UIControlEvents.TouchUpInside, () => {
      this.seekTo(this.position() - SKIP_SECS);
      this.showControls();
    });
    on(this.forwardButton, UIControlEvents.TouchUpInside, () => {
      this.seekTo(this.position() + SKIP_SECS);
      this.showControls();
    });
    on(this.slider, UIControlEvents.ValueChanged, () => this.scrubbing());
    on(
      this.slider,
      UIControlEvents.TouchUpInside | UIControlEvents.TouchUpOutside | UIControlEvents.TouchCancel,
      () => this.scrubbed(),
    );
    on(this.skipButton, UIControlEvents.TouchUpInside, () => this.skipTheIntro());
    on(this.creditsButton, UIControlEvents.TouchUpInside, () => {
      noteInteraction();
      this.upNextDismissed = true;
      this.upNextCard.hidden = true;
    });
    on(this.nextButton, UIControlEvents.TouchUpInside, () => this.playNext(false));
    on(this.subsButton, UIControlEvents.TouchUpInside, () => this.subtitleMenu());
    on(this.audioButton, UIControlEvents.TouchUpInside, () => this.audioMenu());
    on(this.qualityButton, UIControlEvents.TouchUpInside, () => this.qualityMenu());

    // A tap anywhere else shows or hides the controls.
    const tapTarget = new Target();
    tapTarget.fn = () => {
      noteInteraction();
      if (this.controls.alpha > 0) this.hideControls();
      else this.showControls();
    };
    this.keep.push(tapTarget);
    const tap = UITapGestureRecognizer.alloc().initWithTargetAction(tapTarget, "run");
    view.addGestureRecognizer(tap);

    this.vc.onLayout = () => this.layout();
  }

  private layout() {
    const view = this.vc.view;
    const b = view.bounds.size;
    const inset = view.safeAreaInsets;
    const left = Math.max(inset.left, 16);
    const right = Math.max(inset.right, 16);
    const top = Math.max(inset.top, 12);
    const bottom = Math.max(inset.bottom, 12);
    const full = CGRectMake(0, 0, b.width, b.height);
    this.videoView.frame = full;
    this.layer.frame = full;
    this.subsView.frame = full;
    this.controls.frame = full;
    this.spinner.center = CGPointMake(b.width / 2, b.height / 2);

    this.closeButton.frame = CGRectMake(left, top, 44, 44);
    this.pipButton.frame = CGRectMake(b.width - right - 44, top, 44, 44);
    this.route.frame = CGRectMake(b.width - right - (this.pipButton.hidden ? 44 : 96), top, 44, 44);
    this.titleLabel.frame = CGRectMake(left + 56, top - 6, b.width - left - right - 56 - 110, 34);
    this.streamLabel.frame = CGRectMake(left + 56, top + 22, b.width - left - right - 56 - 110, 18);

    const cy = b.height / 2;
    this.playButton.frame = CGRectMake(b.width / 2 - 36, cy - 36, 72, 72);
    this.backButton.frame = CGRectMake(b.width / 2 - 36 - 110, cy - 28, 56, 56);
    this.forwardButton.frame = CGRectMake(b.width / 2 + 36 + 54, cy - 28, 56, 56);

    const barY = b.height - bottom - 44;
    const buttons = [this.subsButton, this.audioButton, this.qualityButton].filter(v => !v.hidden);
    const buttonsW = buttons.length * 44;
    buttons.forEach((v, i) => (v.frame = CGRectMake(b.width - right - buttonsW + i * 44, barY, 44, 44)));
    this.timeLabel.frame = CGRectMake(left, barY, 72, 44);
    const sliderX = left + 76;
    const remainW = 80;
    this.slider.frame = CGRectMake(sliderX, barY, b.width - sliderX - right - buttonsW - remainW - 12, 44);
    this.remainLabel.frame = CGRectMake(this.slider.frame.origin.x + this.slider.frame.size.width + 4, barY, remainW, 44);

    // Skip intro and Up next: bottom right, just above the scrubber.
    this.skipButton.frame = CGRectMake(b.width - right - 132, barY - 52, 132, 44);
    const cardW = Math.min(360, b.width - left - right);
    const cardH = 150;
    this.upNextCard.frame = CGRectMake(b.width - right - cardW, barY - cardH - 8, cardW, cardH);
    this.upNextImage.frame = CGRectMake(12, 12, 140, 79);
    this.upNextHeading.frame = CGRectMake(164, 12, cardW - 176, 18);
    this.upNextName.frame = CGRectMake(164, 32, cardW - 176, 40);
    const half = (cardW - 36) / 2;
    this.creditsButton.frame = CGRectMake(12, 102, half, 36);
    this.nextButton.frame = CGRectMake(24 + half, 102, half, 36);

    if (b.width !== this.drawnWidth) {
      this.drawnWidth = b.width;
      this.shownKey = "x"; // place the subtitles again
    }
    this.showSubs(true);
  }

  // ---- Controls ----

  private showControls() {
    const quality = QUALITIES.find(q => q.id === this.quality)?.label ?? this.quality;
    this.streamLabel.text = `${t(quality)}  ·  ${describeStream(this.pb.stream)}`;
    this.subsButton.hidden = !this.pb.subtitles.some(s => s.url) && !this.canFind();
    this.audioButton.hidden = (this.pb.audio?.length ?? 0) < 2;
    this.layout();
    UIView.animateWithDurationAnimations(0.2, () => (this.controls.alpha = 1));
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.player.rate !== 0 && !this.slider.tracking) this.hideControls();
    }, CONTROLS_HIDE_MS);
  }

  private hideControls() {
    clearTimeout(this.hideTimer);
    UIView.animateWithDurationAnimations(0.25, () => (this.controls.alpha = 0));
  }

  /** Dragging the scrubber: the time under the thumb and the server's frame for it. */
  private scrubbing() {
    clearTimeout(this.hideTimer);
    const at = this.slider.value;
    this.timeLabel.text = formatTime(at);
    const dur = this.duration();
    this.remainLabel.text = dur > 0 ? `-${formatTime(Math.max(0, dur - at))}` : "";
    const s = this.slider.frame;
    const x = s.origin.x + (dur > 0 ? (at / dur) * s.size.width : 0);
    const w = 160;
    const h = 90;
    const px = Math.min(Math.max(x - w / 2, 8), this.vc.view.bounds.size.width - w - 8);
    this.preview.frame = CGRectMake(px, s.origin.y - h - 30, w, h);
    this.previewLabel.frame = CGRectMake(px, s.origin.y - 28, w, 20);
    this.previewLabel.text = formatTime(at);
    this.previewLabel.hidden = false;
    const template = this.pb.preview_url;
    if (!template) return;
    this.preview.hidden = false;
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      const url = previewUrl(template, at);
      ImageSource.fromUrl(url).then(
        src => {
          if (this.slider.tracking) this.preview.image = src.ios as UIImage;
        },
        () => {},
      );
    }, PREVIEW_SETTLE_MS);
  }

  private scrubbed() {
    clearTimeout(this.previewTimer);
    this.preview.hidden = true;
    this.preview.image = null;
    this.previewLabel.hidden = true;
    this.seekTo(this.slider.value);
    this.showControls();
  }

  private toast(text: string) {
    const view = this.vc.view;
    this.toastLabel.text = `  ${text}  `;
    this.toastLabel.sizeToFit();
    const w = Math.min(this.toastLabel.frame.size.width + 16, view.bounds.size.width - 32);
    this.toastLabel.frame = CGRectMake((view.bounds.size.width - w) / 2, view.safeAreaInsets.top + 64, w, 36);
    this.toastLabel.alpha = 1;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => UIView.animateWithDurationAnimations(0.3, () => (this.toastLabel.alpha = 0)), 2000);
  }

  private sheet(title: string, from: UIView, options: { label: string; selected: boolean; pick: Fn }[]) {
    clearTimeout(this.hideTimer);
    const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
      title,
      null,
      UIAlertControllerStyle.ActionSheet,
    );
    for (const o of options) {
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler(`${o.selected ? "✓ " : ""}${o.label}`, UIAlertActionStyle.Default, () => {
          o.pick();
          this.showControls();
        }),
      );
    }
    alert.addAction(
      UIAlertAction.actionWithTitleStyleHandler(t("Cancel"), UIAlertActionStyle.Cancel, () => this.showControls()),
    );
    const pop = alert.popoverPresentationController;
    if (pop) {
      pop.sourceView = from;
      pop.sourceRect = from.bounds;
    }
    this.vc.presentViewControllerAnimatedCompletion(alert, true, () => {});
  }

  // ---- Subtitles ----

  private audioLanguage() {
    return this.pb.audio?.find(a => a.index === this.pb.audio_index)?.language ?? null;
  }

  private chooseSubs(track: SubtitleTrack | null, announce: boolean) {
    this.subs?.close();
    this.subs = track
      ? new SubtitleSource(
          track,
          () => this.showSubs(true),
          () => this.toast(t("These subtitles couldn't be loaded")),
        )
      : null;
    this.timing = track ? savedTiming(this.pb.item_id, track) : 0;
    if (announce) {
      const tracks = this.pb.subtitles.filter(s => s.url);
      const i = track ? tracks.findIndex(s => s.key === track.key) : -1;
      this.toast(i >= 0 ? t("Subtitles: {name}", { name: trackLabels(tracks)[i] }) : t("Subtitles off"));
    }
    this.showSubs(true);
  }

  private showSubs(force = false) {
    if (force) this.shownKey = "x";
    this.draw(this.subs ? this.subs.at(this.position() - this.timing) : null);
  }

  private draw(s: Showing) {
    const key = !s ? "" : s.kind === "text" ? `t:${s.text}` : `b:${s.cue.start}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    const box = this.subsView.bounds.size;
    const v = this.layer.videoRect;
    const pic = v.size.width > 0 ? v : CGRectMake(0, 0, box.width, box.height);
    // Text: centered near the bottom of the picture, above the controls' bar.
    if (s?.kind === "text") {
      this.subLabel.font = UIFont.boldSystemFontOfSize(Math.max(15, Math.min(pic.size.width * 0.032, 30)));
      this.subLabel.text = s.text;
      const width = pic.size.width - 64;
      const fit = this.subLabel.sizeThatFits(CGSizeMake(width, box.height));
      const bottom = Math.min(pic.origin.y + pic.size.height, box.height) - box.height * 0.08;
      this.subLabel.frame = CGRectMake(pic.origin.x + 32, bottom - fit.height, width, fit.height);
      this.subLabel.hidden = false;
    } else {
      this.subLabel.hidden = true;
    }
    // Images: where they were authored, on the picture.
    for (const img of this.subImages) img.removeFromSuperview();
    this.subImages = [];
    if (s?.kind === "bitmap") {
      const sx = pic.size.width / (s.frame.video_width || 1920);
      const sy = pic.size.height / (s.frame.video_height || 1080);
      for (const img of s.cue.images) {
        const iv = UIImageView.alloc().initWithFrame(
          CGRectMake(pic.origin.x + img.x * sx, pic.origin.y + img.y * sy, img.width * sx, img.height * sy),
        );
        iv.contentMode = UIViewContentMode.ScaleAspectFit;
        const url = absolute(img.url);
        const cached = this.imageCache.get(url);
        if (cached) iv.image = cached;
        else if (cached === undefined) {
          this.imageCache.set(url, null);
          ImageSource.fromUrl(url).then(
            src => {
              this.imageCache.set(url, src.ios as UIImage);
              // The oldest go first (a film's worth would be hundreds of MB).
              while (this.imageCache.size > SUB_IMAGES_KEPT) {
                this.imageCache.delete(this.imageCache.keys().next().value as string);
              }
              this.shownKey = "x";
            },
            () => this.imageCache.delete(url),
          );
        }
        this.subsView.addSubview(iv);
        this.subImages.push(iv);
      }
    }
  }

  /** A track in your language (the app's). */
  private mine(code: string | null | undefined) {
    return !!code && languageName(code) === languageName(lang());
  }

  /** Subtitles can be searched for (Bazarr) and it's worth it: nothing in your language among
   * the tracks, and the audio isn't in it either (the TV's rule). */
  private canFind() {
    return this.canSearchSubs && !this.pb.subtitles.some(s => this.mine(s.language)) && !this.mine(this.audioLanguage());
  }

  /** Ask the server (Bazarr) for subtitles in your language; the new file is chosen when found. */
  private async findSubtitles() {
    if (this.finding) return;
    const language = languageName(lang()) ?? lang();
    this.finding = true;
    this.toast(t("Looking for {language} subtitles...", { language }));
    try {
      const r = await api.findSubtitles(this.pb.item_id, lang());
      const before = new Set(this.pb.subtitles.map(s => s.key));
      this.pb.subtitles = r.subtitles;
      const fresh = r.subtitles.find(s => s.url && !before.has(s.key) && this.mine(s.language));
      if (fresh) {
        this.chooseSubs(fresh, true);
        rememberSubtitles(fresh);
      } else this.toast(t("No {language} subtitles found", { language }));
    } catch {
      this.toast(t("No {language} subtitles found", { language }));
    } finally {
      this.finding = false;
    }
  }

  private subtitleMenu() {
    const tracks = this.pb.subtitles.filter(s => s.url);
    const labels = trackLabels(tracks);
    const language = languageName(lang()) ?? lang();
    this.sheet(t("Subtitles"), this.subsButton, [
      ...(this.canFind()
        ? [{ label: t("Find {language} subtitles", { language }), selected: false, pick: () => void this.findSubtitles() }]
        : []),
      ...(this.subs
        ? [{ label: `${t("Subtitle timing")}: ${shortTiming(this.timing)}`, selected: false, pick: () => this.timingMenu() }]
        : []),
      {
        label: t("Off"),
        selected: !this.subs,
        pick: () => {
          this.chooseSubs(null, true);
          rememberSubtitles(null);
        },
      },
      ...tracks.map((track, i) => ({
        label: labels[i],
        selected: this.subs?.track.key === track.key,
        pick: () => {
          this.chooseSubs(track, true);
          rememberSubtitles(track);
        },
      })),
    ]);
  }

  /** Nudge the timing; the menu opens again for the next nudge (iOS menus close on a choice). */
  private timingMenu() {
    const track = this.subs?.track;
    if (!track) return;
    const nudge = (by: number | null) => () => {
      this.timing = by === null ? 0 : clampTiming(this.timing + by);
      saveTiming(this.pb.item_id, track, this.timing);
      this.showSubs(true);
      this.toast(describeTiming(this.timing));
      setTimeout(() => this.timingMenu(), 350);
    };
    this.sheet(`${t("Subtitle timing")}: ${shortTiming(this.timing)}`, this.subsButton, [
      { label: t("{secs} s earlier", { secs: "0.5" }), selected: false, pick: nudge(-0.5) },
      { label: t("{secs} s earlier", { secs: "0.1" }), selected: false, pick: nudge(-0.1) },
      { label: t("{secs} s later", { secs: "0.1" }), selected: false, pick: nudge(0.1) },
      { label: t("{secs} s later", { secs: "0.5" }), selected: false, pick: nudge(0.5) },
      { label: t("No adjustment"), selected: this.timing === 0, pick: nudge(null) },
    ]);
  }

  // ---- Audio and quality: both start the stream again where you are ----

  /** Your audio track for this title, remembered on this phone (the TV's key). */
  private audioKey() {
    return audioChoice(this.target.kind, this.target.id);
  }

  private savedAudio(): number | undefined {
    return read(this.audioKey()) ?? undefined;
  }

  private audioMenu() {
    const tracks: AudioTrack[] = this.pb.audio ?? [];
    const labels = audioLabels(tracks);
    this.sheet(
      t("Audio"),
      this.audioButton,
      tracks.map((a, i) => ({
        label: labels[i],
        selected: a.index === this.pb.audio_index,
        pick: () => {
          this.audioIndex = a.index;
          write(this.audioKey(), a.index);
          void this.restart(this.position());
        },
      })),
    );
  }

  private qualityMenu() {
    this.sheet(
      t("Quality"),
      this.qualityButton,
      QUALITIES.map(q => ({
        label: t(q.label),
        selected: q.id === this.quality,
        pick: () => {
          this.quality = q.id;
          this.stallCap = null; // an explicit choice overrides step-downs
          saveQuality(q.id);
          void this.restart(this.position());
        },
      })),
    );
  }
}
