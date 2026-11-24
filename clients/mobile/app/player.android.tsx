// The player on Android, as on the TV and the iPhone (player.ios.ts): the picture fills the screen
// (turned landscape, system bars hidden), our own controls over it (title, quality and stream,
// play and ±10 s, the timeline with scrub previews, Subtitles / Audio / Quality when there's a
// choice), and the same rules: seeks outside an HLS session restart it there (`planSeek`),
// buffering steps the bitrate down (`StallMonitor`), a broken stream restarts where it was (three
// times a minute), progress is saved every 10 s and on close, the audio choice is remembered per
// title, subtitles are drawn over the picture (text, and image subtitles where they were authored)
// with per-track timing. Media3's PlayerView shows the picture; it plays direct files and HLS.
import { render } from "@nativescript-community/solid-js";
import {
  AbsoluteLayout,
  AndroidApplication,
  Application,
  Dialogs,
  Frame,
  GridLayout,
  Image,
  Label,
  type NavigatedData,
  Page,
  Placeholder,
  type TouchGestureEventData,
  type View,
} from "@nativescript/core";
import { absolute, api, HttpError, imageUrl } from "@tv/api/client";
import type { ClientProfile, Item, Playback, SubtitleTrack } from "@tv/api/types";
import { formatTime, languageName } from "@tv/format";
import { lang, t } from "@tv/i18n";
import { audioLabels } from "@tv/playback/audio";
import { QUALITIES, describeStream, profileFor, saveQuality, savedQuality, type QualityId } from "@tv/playback/quality";
import { planSeek } from "@tv/playback/seek";
import { DEFAULT_STALLS, StallMonitor, stepDownBudget } from "@tv/playback/stalls";
import { clampTiming, describeTiming, saveTiming, savedTiming, shortTiming, trackLabels } from "@tv/playback/subtitles";
import { previewUrl } from "@tv/playback/trickplay";
import { Show, createSignal } from "solid-js";
import { setPlayerOpen } from "./clip.android";
import { rootFrame } from "./nav";
import { features } from "./features";
import { STATE_BUFFERING, STATE_ENDED, coverTexture, listen, mediaItem, newPlayer, type Exo } from "./media3.android";
import { phoneProfile } from "./profile.android";
import { SubtitleSource, initialTrack, rememberSubtitles, type Showing } from "./subtitles";
import { audioChoice, read, write } from "@tv/platform/settings";
import type { PlayTarget } from "./platformTypes";
import { nowPlaying } from "./nowPlaying.android";
import { castButton, castLoad, castSeek, castSubtitles, followCasting, remote, stopCasting } from "./cast.android";
import { nowPlayingInfo, type NowPlayingSession } from "@tv/platform/types";

const SAVE_EVERY_MS = 10_000;
const CONTROLS_HIDE_MS = 4000;
/** The server keeps HLS segments 120 s behind the viewer; seeking further back restarts. */
const KEEP_BEHIND_SECS = 90;
const PREVIEW_SETTLE_MS = 150;
const SKIP_SECS = 10;
/** The longest playback waits for its picture surface before starting anyway (sound at least). */
const SURFACE_WAIT_MS = 3000;
/** What a Chromecast plays through Google's receiver: H.264 and AAC, up to 1080p (4K and HEVC
 * only some can, and nothing here says which). */
const CAST_PROFILE: ClientProfile = {
  containers: ["mp4"],
  video_codecs: ["h264"],
  audio_codecs: ["aac", "mp3"],
  max_height: 1080,
  supports_hdr: false,
  supports_dolby_vision: false,
  max_audio_channels: 6,
};
/** A seek on the Chromecast further ahead than this gets it a new stream from there. */
const CAST_SEEK_AHEAD = 120;
/** A stop this soon after the picture-in-picture window went full size is that window closing. */
const PIP_CLOSE_MS = 1500;


let current: AndroidPlayer | null = null;

/** Play `target` from `startSecs`. `onClose`: where to land after (Continue Watching passes the
 * title's page). */
export async function play(target: PlayTarget, startSecs = 0, onClose?: () => void): Promise<void> {
  if (current) return;
  const p = new AndroidPlayer(target, onClose);
  current = p;
  try {
    await p.open(startSecs);
  } catch (e) {
    current = null;
    throw e;
  }
}

/** Debug builds: seek the open player (devLaunch `-pandaSeek`). */
export const devSeek = (secs: number) => current?.seekTo(secs);

class AndroidPlayer {
  private pb!: Playback;
  private info: Item | null = null;
  private readonly exo: Exo = newPlayer(true);
  private offset = 0;
  private pending: number | null = null;
  private quality: QualityId = savedQuality();
  private audioIndex: number | undefined;
  private stallCap: number | null = null;
  private readonly stalls = new StallMonitor();
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private waiting = false;
  private retries: number[] = [];
  private closed = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private canSearchSubs = false;
  private finding = false;
  private unlisten: (() => void) | null = null;
  private root: GridLayout | null = null;
  private frame: Frame | undefined;
  private dispose: (() => void) | null = null;
  private videoSize: [number, number] = [0, 0];
  private videoBox: View | null = null;
  /** The picture: a TextureView (it sits under the controls like any view; a SurfaceView punches
   * through the window and anything opaque over it hides the video). */
  private readonly texture = new android.view.TextureView(Application.android.context as android.content.Context);

  // What the controls show (signals: the view below reads them).
  private readonly s = {
    tick: createSignal(0),
    controls: createSignal(true),
    playing: createSignal(false),
    busy: createSignal(true),
    toast: createSignal(""),
    title: createSignal(""),
    stream: createSignal(""),
    showing: createSignal<Showing>(null),
    scrubAt: createSignal<number | null>(null),
    previewAt: createSignal<number | null>(null),
    timing: createSignal(0),
    /** In a picture-in-picture window: the picture only (no controls or text subtitles). */
    pip: createSignal(false),
    /** Casting: the Chromecast's name ("Living Room TV"), or null. */
    casting: createSignal<string | null>(null),
  };
  /** Casting: the Chromecast's stream, where it starts in the file, and the last position it
   * reported (the phone's own player is paused meanwhile). */
  private cast: { pb: Playback; offset: number; at: number; tracks: Map<string, number> } | null = null;
  private stopFollowingCast: (() => void) | null = null;
  /** The lock screen and notification's controls (nowPlaying.android.ts). */
  private media: NowPlayingSession | null = null;
  private subs: SubtitleSource | null = null;

  constructor(
    private readonly target: PlayTarget,
    private readonly onClose?: () => void,
  ) {
    this.audioIndex = this.savedAudio();
    // The picture's view goes to the player before anything plays: given one mid-stream, the
    // decoder has to switch outputs, which some decoders (the emulator's) can't.
    this.exo.setVideoTextureView(this.texture);
    this.texture.addOnLayoutChangeListener(
      new android.view.View.OnLayoutChangeListener({
        onLayoutChange: () => coverTexture(this.texture, this.videoSize[0], this.videoSize[1], "contain"),
      }),
    );
  }

  // ---- Streams ----

  /** A stream from `at`: for this phone, or for `forDevice` (a Chromecast). */
  private async request(at: number, forDevice?: ClientProfile): Promise<Playback> {
    const chosen = forDevice ?? (await profileFor(phoneProfile(), this.quality));
    const profile =
      this.stallCap === null || forDevice
        ? chosen
        : { ...chosen, max_bitrate_kbps: Math.min(chosen.max_bitrate_kbps ?? Infinity, this.stallCap) };
    const target = this.target;
    try {
      return target.kind === "title"
        ? await api.playTitle(target.id, profile, at, target.version, this.audioIndex)
        : await api.startPlayback(target.id, profile, at, this.audioIndex);
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) {
        throw new Error(t("This title's storage isn't reachable right now. Check that the NAS is on and connected."));
      }
      throw e;
    }
  }

  /**
   * Run `fn` once the picture's surface exists (the page is on screen). Started earlier, the
   * decoder draws into a stand-in surface and is then switched to the real one, which some
   * decoders don't follow (the emulator's: sound, a black picture) and others show as a flash.
   */
  private whenSurface(fn: () => void) {
    const since = Date.now();
    const check = () => {
      if (this.closed) return;
      if (this.texture.isAvailable() || Date.now() - since > SURFACE_WAIT_MS) fn();
      else setTimeout(check, 30);
    };
    check();
  }

  private load(pb: Playback, at: number) {
    this.pb = pb;
    this.offset = pb.method === "hls" ? pb.start_secs : 0;
    this.stalls.reset(Date.now());
    this.exo.setMediaItem(mediaItem(absolute(pb.url), pb.method === "hls"), pb.method === "direct_play" ? at * 1000 : 0);
    this.whenSurface(() => {
      this.exo.prepare();
      this.exo.play();
    });
    const quality = QUALITIES.find((q) => q.id === this.quality)?.label ?? this.quality;
    this.s.stream[1](`${t(quality)}  ·  ${describeStream(pb.stream)}`);
  }

  private async restart(at: number) {
    if (this.pending !== null || this.closed) return;
    const was = this.pb;
    this.pending = at;
    this.s.busy[1](true);
    this.exo.pause();
    let started = false;
    try {
      const pb = await this.request(at);
      if (this.closed) {
        if (pb.method === "hls") void api.stopSession(pb.session_id);
        return;
      }
      this.load(pb, at);
      started = true;
      // The same subtitle track again, with this stream's (newly signed) address.
      const key = this.subs?.track.key;
      this.chooseSubs(key ? (pb.subtitles.find((s) => s.key === key) ?? null) : null, false);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
      this.exo.play();
    } finally {
      this.pending = null;
    }
    if (started && was.method === "hls") void api.stopSession(was.session_id);
  }

  position(): number {
    if (this.cast) {
      const client = remote();
      return client ? this.cast.offset + client.getApproximateStreamPosition() / 1000 : this.cast.at;
    }
    if (this.pending !== null) return this.pending;
    return this.offset + this.exo.getCurrentPosition() / 1000;
  }

  duration(): number {
    const known = this.info?.duration_secs;
    if (known) return known;
    const d = this.exo.getDuration();
    return d > 0 ? this.offset + d / 1000 : 0;
  }

  /** End (file time) of what this stream can play now (an HLS playlist grows as it's made). */
  private availableEnd(): number {
    const d = this.exo.getDuration();
    return this.offset + (d > 0 ? d / 1000 : this.exo.getBufferedPosition() / 1000);
  }

  seekTo(target: number) {
    if (this.cast) return this.castSeekTo(target);
    if (!this.pb) return;
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
    if (action.kind === "jump") this.exo.seekTo(Math.round(action.mediaTime * 1000));
    else void this.restart(action.at);
    this.showSubs();
  }

  // ---- Playing here, or on a Chromecast ----

  private isPlaying(): boolean {
    return this.cast ? !!remote()?.isPlaying() : this.exo.isPlaying();
  }

  private play() {
    if (this.cast) remote()?.play();
    else this.exo.play();
  }

  private pause() {
    if (this.cast) remote()?.pause();
    else this.exo.pause();
  }

  /** Connected to a Chromecast: it plays from here (the phone pauses and lets its stream go). */
  private async startCasting(device: string) {
    if (this.cast || this.closed) return;
    const at = this.position();
    this.exo.pause();
    this.s.casting[1](device);
    await this.castFrom(at);
    if (this.cast && this.pb?.method === "hls") void api.stopSession(this.pb.session_id);
  }

  /** Give the Chromecast a stream from `at` (file time), replacing the one it has. */
  private async castFrom(at: number) {
    const client = remote();
    if (!client || this.closed) return;
    this.s.busy[1](true);
    try {
      const pb = await this.request(at, CAST_PROFILE);
      const was = this.cast?.pb;
      const text = pb.subtitles.filter((s) => s.overlay === "text" && s.url);
      const tracks = new Map(text.map((s, i) => [s.key, i + 1] as const));
      const shown = this.subs ? (tracks.get(this.subs.track.key) ?? null) : null;
      const art = this.info ? (this.info.backdrop ?? this.info.poster) : null;
      const labels = trackLabels(text);
      castLoad(client, {
        url: absolute(pb.url),
        hls: pb.method === "hls",
        title: this.s.title[0]() || "Panda",
        artwork: imageUrl(art) ?? null,
        startSecs: pb.method === "hls" ? 0 : at,
        subtitles: text.map((s, i) => ({ id: i + 1, url: absolute(s.url!), language: s.language, name: labels[i] })),
        selected: shown,
      });
      this.cast = { pb, offset: pb.method === "hls" ? pb.start_secs : 0, at, tracks };
      if (was?.method === "hls") void api.stopSession(was.session_id);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
    } finally {
      this.s.busy[1](false);
    }
  }

  /** Seeking on the Chromecast: within its stream (behind, or a little ahead), else a new one. */
  private castSeekTo(target: number) {
    const client = remote();
    if (!client || !this.cast) return;
    const dur = this.duration();
    const to = Math.max(0, dur > 0 ? Math.min(target, dur - 1) : target);
    if (to >= this.cast.offset && to - this.position() < CAST_SEEK_AHEAD) castSeek(client, to - this.cast.offset);
    else void this.castFrom(to);
  }

  /** The Chromecast let go: the phone plays on from where it was. */
  private endCasting() {
    if (!this.cast) return;
    const { pb, at } = this.cast;
    this.cast = null;
    this.s.casting[1](null);
    if (pb.method === "hls") void api.stopSession(pb.session_id);
    if (!this.closed) void this.restart(at);
  }

  private save() {
    if (!this.pb) return Promise.resolve();
    return api.progress(this.pb.item_id, this.position(), this.duration() || undefined).catch(() => {});
  }

  // ---- Opening and closing ----

  async open(startSecs: number) {
    setPlayerOpen(true);
    try {
      this.load(await this.request(startSecs), startSecs);
    } catch (e) {
      setPlayerOpen(false);
      this.exo.release();
      throw e;
    }
    api.item(this.pb.item_id).then(
      (i) => {
        this.info = i;
        this.updateMedia(true);
        this.s.title[1](
          i.kind === "episode"
            ? `${i.series ?? ""}  S${i.season ?? 0}:E${i.episode ?? 0}  ${i.episode_title ?? ""}`.trim()
            : (i.meta_title ?? i.title),
        );
      },
      () => {},
    );
    this.unlisten = listen(this.exo, {
      isPlaying: (p) => {
        this.s.playing[1](p);
        if (p) this.s.busy[1](false);
        this.updateMedia();
      },
      playbackState: (st) => {
        const waiting = st === STATE_BUFFERING && this.pending === null && this.exo.getPlayWhenReady();
        this.s.busy[1](st === STATE_BUFFERING || this.pending !== null);
        this.watchStalls(waiting);
        // The end: saved (the server marks it finished), and the player closes.
        if (st === STATE_ENDED && this.pending === null) this.close();
      },
      error: () => {
        if (this.pending === null && !this.closed) this.recover();
      },
      videoSize: (w, h) => {
        this.videoSize = [w, h];
        coverTexture(this.texture, w, h, "contain");
        this.pipParams(true);
        this.bump();
      },
    });
    this.chooseSubs(initialTrack(this.pb.subtitles, this.audioLanguage()), false);
    void features().then((f) => (this.canSearchSubs = !!f?.subtitle_search));
    this.present();
    this.timers.push(
      setInterval(() => {
        if (this.isPlaying()) void this.save();
      }, SAVE_EVERY_MS),
      // Times, the timeline and subtitles follow playback; while the controls are hidden only the
      // subtitles do.
      setInterval(() => {
        if (this.cast) {
          this.cast.at = this.position();
          this.s.playing[1](this.isPlaying());
        }
        if (this.s.controls[0]()) this.bump();
        this.showSubs();
      }, 250),
      setInterval(() => this.updateMedia(), 1000),
    );
    this.stopFollowingCast = followCasting({
      started: (device) => void this.startCasting(device),
      ended: () => this.endCasting(),
    });
    this.media = nowPlaying.start(this.mediaInfo(), {
      play: () => this.play(),
      pause: () => this.pause(),
      seekTo: (secs) => this.seekTo(secs),
    });
    // Leaving the app: the sound goes on (the media service keeps it running, with its
    // controls on the lock screen), or the picture goes on in a small window (Android 12+).
    Application.on(Application.backgroundEvent, this.onBackground);
    Application.android.on(AndroidApplication.activityStoppedEvent, this.onStopped);
  }

  private readonly onBackground = () => {
    void this.save();
  };

  /** When the picture-in-picture window last went back to full size (its close does too, first). */
  private pipEndedAt = 0;

  /** The window stopped while (or just after) being picture in picture: it was closed, so pause. */
  private readonly onStopped = () => {
    if (this.s.pip[0]() || Date.now() - this.pipEndedAt < PIP_CLOSE_MS) this.exo.pause();
  };

  private mediaInfo() {
    const art = this.info ? (this.info.backdrop ?? this.info.poster) : null;
    return nowPlayingInfo(this.info, imageUrl(art) ?? null, this.duration());
  }

  /** Where it's at, for the system's controls (`info`: the title too). */
  private updateMedia(info = false) {
    if (!this.media || this.closed) return;
    if (info) this.media.setInfo(this.mediaInfo());
    this.media.setPosition(this.position(), this.isPlaying());
  }

  private activity() {
    return (Application.android.foregroundActivity ?? Application.android.startActivity) as android.app.Activity;
  }

  /**
   * Picture in picture (Android 12+): leaving the app while it plays shrinks the picture into a
   * small window instead of stopping it; `on` false turns that off (the player closing).
   */
  private pipParams(on: boolean) {
    if (android.os.Build.VERSION.SDK_INT < 31) return;
    const b = new android.app.PictureInPictureParams.Builder().setAutoEnterEnabled(on).setSeamlessResizeEnabled(true);
    const [w, h] = this.videoSize;
    // Android takes ratios between 1:2.39 and 2.39:1.
    if (w > 0 && h > 0) b.setAspectRatio(new android.util.Rational(Math.round(Math.min(w, h * 2.39)), Math.round(h)));
    try {
      this.activity().setPictureInPictureParams(b.build());
    } catch (e) {
      console.log(`picture in picture: ${String(e)}`);
    }
  }

  /** The window became (or stopped being) picture in picture: the picture only, or the controls back. */
  private checkPip() {
    if (android.os.Build.VERSION.SDK_INT < 26) return;
    const pip = this.activity().isInPictureInPictureMode();
    if (pip === this.s.pip[0]()) return;
    this.s.pip[1](pip);
    if (!pip) this.pipEndedAt = Date.now();
    if (pip) {
      clearTimeout(this.hideTimer);
      this.s.controls[1](false);
    } else this.showControls();
  }

  private bump() {
    this.s.tick[1]((n) => n + 1);
  }

  /** Full screen over the app: landscape, system bars hidden, the screen kept on. */
  private present() {
    const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as android.app.Activity;
    activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    const root = document.createElement("gridlayout") as unknown as GridLayout;
    root.backgroundColor = "#000000";
    this.root = root;
    this.dispose = render(() => this.view(), root as unknown as Element);
    // A page of the app's own window (in a dialog window the picture stays black), so Back
    // closes it as it closes any page.
    const frame = rootFrame() ?? Frame.topmost();
    this.frame = frame;
    const page = new Page();
    page.actionBarHidden = true;
    page.backgroundColor = "#000000";
    page.content = root;
    root.on("layoutChanged", () => this.checkPip());
    page.on("navigatedFrom", (e: NavigatedData) => {
      if (e.isBackNavigation && !this.closed) this.close(true);
    });
    frame?.navigate({ create: () => page, animated: false });
    const w = activity.getWindow();
    w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    const c = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
    c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
    c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    this.pipParams(true);
    this.showControls();
  }

  /** `fromBack`: Back left the page already. */
  private close(fromBack = false) {
    if (this.closed) return;
    this.closed = true;
    void this.save();
    for (const tm of this.timers) clearInterval(tm);
    clearTimeout(this.stallTimer);
    clearTimeout(this.hideTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.previewTimer);
    Application.off(Application.backgroundEvent, this.onBackground);
    Application.android.off(AndroidApplication.activityStoppedEvent, this.onStopped);
    this.pipParams(false);
    this.stopFollowingCast?.();
    if (this.cast) {
      const pb = this.cast.pb;
      this.cast = null;
      if (pb.method === "hls") void api.stopSession(pb.session_id);
      stopCasting();
    }
    this.media?.end();
    this.media = null;
    this.subs?.close();
    this.unlisten?.();
    this.exo.release();
    if (this.pb?.method === "hls") void api.stopSession(this.pb.session_id);
    const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as android.app.Activity;
    activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    const w = activity.getWindow();
    w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView()).show(
      androidx.core.view.WindowInsetsCompat.Type.systemBars(),
    );
    if (!fromBack) this.frame?.goBack();
    this.dispose?.();
    current = null;
    setPlayerOpen(false);
    this.onClose?.();
  }

  // ---- When it struggles (the TV's rules) ----

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

  private stepDown() {
    const next = stepDownBudget(this.pb.stream.bitrate_kbps);
    if (next === null) return;
    this.stallCap = next;
    this.toast(t("Slow connection: lowering quality to {mbps} Mbps", { mbps: (next / 1000).toFixed(1) }));
    void this.restart(this.position());
  }

  private recover() {
    const now = Date.now();
    this.retries = this.retries.filter((at) => now - at < 60_000);
    if (this.retries.length >= 3) {
      this.exo.stop();
      this.toast(t("Playback stopped. Check that the NAS is on and connected, then try again."));
      return;
    }
    this.retries.push(now);
    void this.restart(this.position());
  }

  // ---- Controls ----

  private showControls() {
    if (this.s.pip[0]()) return;
    this.s.controls[1](true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.isPlaying() && this.s.scrubAt[0]() === null) this.s.controls[1](false);
    }, CONTROLS_HIDE_MS);
  }

  private toast(text: string) {
    this.s.toast[1](text);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.s.toast[1](""), 2500);
  }

  private async menu(title: string, options: { label: string; selected: boolean; pick: () => void }[]) {
    clearTimeout(this.hideTimer);
    const labels = options.map((o) => `${o.selected ? "✓ " : ""}${o.label}`);
    const choice = await Dialogs.action({ title, cancelButtonText: t("Cancel"), actions: labels });
    const i = labels.indexOf(choice);
    if (i >= 0) options[i].pick();
    this.showControls();
  }

  // ---- Subtitles ----

  private audioLanguage() {
    return this.pb.audio?.find((a) => a.index === this.pb.audio_index)?.language ?? null;
  }

  private chooseSubs(track: SubtitleTrack | null, announce: boolean) {
    this.subs?.close();
    this.subs = track
      ? new SubtitleSource(
          track,
          () => this.showSubs(),
          () => this.toast(t("These subtitles couldn't be loaded")),
        )
      : null;
    this.s.timing[1](track ? savedTiming(this.pb.item_id, track) : 0);
    const client = this.cast ? remote() : null;
    if (client && this.cast) castSubtitles(client, track ? (this.cast.tracks.get(track.key) ?? null) : null);
    if (announce) {
      const tracks = this.pb.subtitles.filter((s) => s.url);
      const i = track ? tracks.findIndex((s) => s.key === track.key) : -1;
      this.toast(i >= 0 ? t("Subtitles: {name}", { name: trackLabels(tracks)[i] }) : t("Subtitles off"));
    }
    this.showSubs();
  }

  private showSubs() {
    const showing = this.subs ? this.subs.at(this.position() - this.s.timing[0]()) : null;
    // A picture-in-picture window is too small for text at its size; image subtitles scale.
    this.s.showing[1](this.s.pip[0]() && showing?.kind === "text" ? null : showing);
  }

  private mine(code: string | null | undefined) {
    return !!code && languageName(code) === languageName(lang());
  }

  private canFind() {
    return this.canSearchSubs && !this.pb.subtitles.some((s) => this.mine(s.language)) && !this.mine(this.audioLanguage());
  }

  private async findSubtitles() {
    if (this.finding) return;
    const language = languageName(lang()) ?? lang();
    this.finding = true;
    this.toast(t("Looking for {language} subtitles...", { language }));
    try {
      const r = await api.findSubtitles(this.pb.item_id, lang());
      const before = new Set(this.pb.subtitles.map((s) => s.key));
      this.pb.subtitles = r.subtitles;
      const fresh = r.subtitles.find((s) => s.url && !before.has(s.key) && this.mine(s.language));
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
    const tracks = this.pb.subtitles.filter((s) => s.url);
    const labels = trackLabels(tracks);
    const language = languageName(lang()) ?? lang();
    void this.menu(t("Subtitles"), [
      ...(this.canFind()
        ? [{ label: t("Find {language} subtitles", { language }), selected: false, pick: () => void this.findSubtitles() }]
        : []),
      ...(this.subs
        ? [{ label: `${t("Subtitle timing")}: ${shortTiming(this.s.timing[0]())}`, selected: false, pick: () => this.timingMenu() }]
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

  /** Nudge the timing; the menu opens again for the next nudge. */
  private timingMenu() {
    const track = this.subs?.track;
    if (!track) return;
    const nudge = (by: number | null) => () => {
      const next = by === null ? 0 : clampTiming(this.s.timing[0]() + by);
      this.s.timing[1](next);
      saveTiming(this.pb.item_id, track, next);
      this.showSubs();
      this.toast(describeTiming(next));
      setTimeout(() => this.timingMenu(), 350);
    };
    void this.menu(`${t("Subtitle timing")}: ${shortTiming(this.s.timing[0]())}`, [
      { label: t("{secs} s earlier", { secs: "0.5" }), selected: false, pick: nudge(-0.5) },
      { label: t("{secs} s earlier", { secs: "0.1" }), selected: false, pick: nudge(-0.1) },
      { label: t("{secs} s later", { secs: "0.1" }), selected: false, pick: nudge(0.1) },
      { label: t("{secs} s later", { secs: "0.5" }), selected: false, pick: nudge(0.5) },
      { label: t("No adjustment"), selected: this.s.timing[0]() === 0, pick: nudge(null) },
    ]);
  }

  // ---- Audio and quality: both start the stream again where you are ----

  private audioKey() {
    return audioChoice(this.target.kind, this.target.id);
  }

  private savedAudio(): number | undefined {
    return read(this.audioKey()) ?? undefined;
  }

  private audioMenu() {
    const tracks = this.pb.audio ?? [];
    const labels = audioLabels(tracks);
    void this.menu(
      t("Audio"),
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
    void this.menu(
      t("Quality"),
      QUALITIES.map((q) => ({
        label: t(q.label),
        selected: q.id === this.quality,
        pick: () => {
          this.quality = q.id;
          this.stallCap = null;
          saveQuality(q.id);
          void this.restart(this.position());
        },
      })),
    );
  }

  // ---- The view ----

  /** Where the picture is inside the player (fitted): image subtitles are placed on it. */
  private pictureRect() {
    const box = this.videoBox;
    const W = box?.getActualSize().width ?? 0;
    const H = box?.getActualSize().height ?? 0;
    const [vw, vh] = this.videoSize;
    if (!W || !H || !vw || !vh) return { x: 0, y: 0, w: W, h: H };
    const scale = Math.min(W / vw, H / vh);
    return { x: (W - vw * scale) / 2, y: (H - vh * scale) / 2, w: vw * scale, h: vh * scale };
  }

  private view() {
    const s = this.s;
    const tick = () => s.tick[0]();
    const pos = () => (tick(), this.position());
    const dur = () => (tick(), this.duration());
    const shownAt = () => s.scrubAt[0]() ?? pos();
    const fraction = (secs: number) => (dur() > 0 ? Math.min(1, Math.max(0, secs / dur())) : 0);
    let bar: GridLayout | undefined;
    const atTouch = (x: number) => {
      const w = bar?.getActualSize().width ?? 1;
      return Math.max(0, Math.min(1, x / w)) * dur();
    };
    const onScrub = (e: TouchGestureEventData) => {
      // Android reports touch positions in pixels.
      const x = e.getX() / (e.view.android as android.view.View).getResources().getDisplayMetrics().density;
      const at = atTouch(x);
      if (e.action === "down" || e.action === "move") {
        s.scrubAt[1](at);
        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => s.previewAt[1](at), PREVIEW_SETTLE_MS);
        this.showControls();
      } else if (e.action === "up") {
        s.scrubAt[1](null);
        s.previewAt[1](null);
        this.seekTo(at);
        this.showControls();
      } else if (e.action === "cancel") {
        s.scrubAt[1](null);
        s.previewAt[1](null);
      }
    };
    const btn = (icon: string, onTap: () => void, size = 22) => {
      const l = new Label();
      l.text = icon;
      l.className = "player-icon";
      l.fontSize = size;
      l.on("tap", () => {
        onTap();
        this.showControls();
      });
      return l;
    };
    const hasSubs = () => (tick(), (this.pb?.subtitles.some((x) => x.url) ?? false) || this.canFind());
    const hasAudio = () => (tick(), (this.pb?.audio?.length ?? 0) > 1);
    return (
      <gridlayout rows="*" columns="*">
        {/* The picture (taps show or hide the controls). */}
        <contentview
          ref={(el: View) => {
            this.videoBox = el;
            const holder = new Placeholder();
            holder.on("creatingView", (e: { view: unknown }) => (e.view = this.texture));
            (el as unknown as { content: View }).content = holder;
          }}
          on:tap={() => {
            if (s.controls[0]()) {
              clearTimeout(this.hideTimer);
              s.controls[1](false);
            } else this.showControls();
          }}
        />
        {/* Subtitles: text near the bottom, image subtitles where they were authored. */}
        <Show when={s.showing[0]()?.kind === "text"}>
          <label
            class="player-sub"
            textWrap={true}
            verticalAlignment="bottom"
            marginBottom={s.controls[0]() ? 110 : 28}
            isUserInteractionEnabled={false}
            text={(s.showing[0]() as { text: string }).text}
          />
        </Show>
        <Show when={s.showing[0]()?.kind === "bitmap" ? (s.showing[0]() as Extract<Showing, { kind: "bitmap" }>) : null}>
          {(b) => {
            const layer = new AbsoluteLayout();
            layer.isUserInteractionEnabled = false;
            const draw = () => {
              layer.removeChildren();
              const r = this.pictureRect();
              const sx = r.w / (b().frame.video_width || 1920);
              const sy = r.h / (b().frame.video_height || 1080);
              for (const img of b().cue.images) {
                const v = new Image();
                v.loadMode = "async";
                v.stretch = "aspectFit";
                v.src = absolute(img.url);
                v.width = img.width * sx;
                v.height = img.height * sy;
                AbsoluteLayout.setLeft(v, r.x + img.x * sx);
                AbsoluteLayout.setTop(v, r.y + img.y * sy - (s.controls[0]() ? 80 : 0));
                layer.addChild(v);
              }
            };
            draw();
            return <contentview ref={(el: View) => ((el as unknown as { content: View }).content = layer)} isUserInteractionEnabled={false} />;
          }}
        </Show>
        <Show when={s.busy[0]()}>
          <activityindicator busy={true} color="#f4f1ea" width={48} height={48} isUserInteractionEnabled={false} />
        </Show>
        {/* The controls. */}
        <gridlayout rows="auto, *, auto" class="player-controls" opacity={s.controls[0]() ? 1 : 0} isUserInteractionEnabled={s.controls[0]()}>
          <gridlayout row={0} columns="auto, *, auto" class="player-top">
            <contentview col={0} ref={(el: View) => ((el as unknown as { content: View }).content = btn("✕", () => this.close(), 22))} />
            <stacklayout col={1} class="player-titles">
              <label class="player-title" text={s.title[0]()} />
              <label class="player-stream" text={s.stream[0]()} />
            </stacklayout>
            <contentview
              col={2}
              verticalAlignment="middle"
              ref={(el: View) => {
                const holder = new Placeholder();
                holder.on("creatingView", (e: { view: unknown }) => {
                  const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as android.content.Context;
                  e.view = castButton(activity) ?? new android.view.View(activity);
                });
                (el as unknown as { content: View }).content = holder;
              }}
            />
          </gridlayout>
          <stacklayout row={1} orientation="horizontal" horizontalAlignment="center" verticalAlignment="middle" class="player-center">
            <contentview ref={(el: View) => ((el as unknown as { content: View }).content = btn("↺10", () => this.seekTo(this.position() - SKIP_SECS), 24))} />
            <label
              class="player-icon big"
              text={s.playing[0]() ? "❚❚" : "▶"}
              on:tap={() => {
                if (this.isPlaying()) this.pause();
                else this.play();
                this.showControls();
              }}
            />
            <contentview ref={(el: View) => ((el as unknown as { content: View }).content = btn("10↻", () => this.seekTo(this.position() + SKIP_SECS), 24))} />
          </stacklayout>
          <stacklayout row={2} class="player-bottom">
            <Show when={s.scrubAt[0]() !== null}>
              <stacklayout horizontalAlignment="left" marginLeft={Math.max(0, fraction(s.scrubAt[0]() ?? 0) * ((bar?.getActualSize().width ?? 300) - 160))}>
                <Show when={this.pb?.preview_url && s.previewAt[0]() !== null}>
                  <image class="player-preview" loadMode="async" src={previewUrl(this.pb.preview_url!, s.previewAt[0]()!)} />
                </Show>
                <label class="player-time" text={formatTime(s.scrubAt[0]() ?? 0)} />
              </stacklayout>
            </Show>
            <gridlayout
              class="player-bar"
              columns="*"
              ref={(el: GridLayout) => (bar = el)}
              on:touch={onScrub}
            >
              <stacklayout class="player-track" />
              <stacklayout class="player-played" horizontalAlignment="left" width={`${fraction(shownAt()) * 100}%`} />
            </gridlayout>
            <gridlayout columns="auto, *, auto, auto, auto" class="player-row">
              <label col={0} class="player-time" text={`${formatTime(shownAt())} / ${formatTime(dur())}`} />
              <Show when={hasSubs()}>
                <label col={2} class="player-icon" text="CC" on:tap={() => this.subtitleMenu()} />
              </Show>
              <Show when={hasAudio()}>
                <label col={3} class="player-icon" text="♪" on:tap={() => this.audioMenu()} />
              </Show>
              <label col={4} class="player-icon" text="⚙" on:tap={() => this.qualityMenu()} />
            </gridlayout>
          </stacklayout>
        </gridlayout>
        <Show when={s.casting[0]()}>
          <label
            class="player-casting"
            text={t("Playing on {device}", { device: s.casting[0]()! })}
            verticalAlignment="middle"
            horizontalAlignment="center"
            isUserInteractionEnabled={false}
          />
        </Show>
        <Show when={s.toast[0]()}>
          <label class="player-toast" text={s.toast[0]()} verticalAlignment="top" horizontalAlignment="center" isUserInteractionEnabled={false} />
        </Show>
      </gridlayout>
    );
  }
}

