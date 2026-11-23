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
import { absolute, api, HttpError } from "@tv/api/client";
import type { Item, Playback, SubtitleTrack } from "@tv/api/types";
import { formatTime, languageName } from "@tv/format";
import { lang, t } from "@tv/i18n";
import { audioLabels } from "@tv/playback/audio";
import { QUALITIES, describeStream, profileFor, saveQuality, savedQuality, type QualityId } from "@tv/playback/quality";
import { planSeek } from "@tv/playback/seek";
import { DEFAULT_STALLS, StallMonitor, stepDownBudget } from "@tv/playback/stalls";
import { clampTiming, describeTiming, saveTiming, savedTiming, shortTiming, trackLabels } from "@tv/playback/subtitles";
import { previewUrl } from "@tv/playback/trickplay";
import { Show, createSignal } from "solid-js";
import { setPlayerOpen } from "./clip";
import { rootFrame } from "./nav";
import { features } from "./features";
import { STATE_BUFFERING, STATE_ENDED, coverTexture, listen, mediaItem, newPlayer, type Exo } from "./media3.android";
import { phoneProfile } from "./profile";
import { SubtitleSource, initialTrack, rememberSubtitles, type Showing } from "./subtitles";

const SAVE_EVERY_MS = 10_000;
const CONTROLS_HIDE_MS = 4000;
/** The server keeps HLS segments 120 s behind the viewer; seeking further back restarts. */
const KEEP_BEHIND_SECS = 90;
const PREVIEW_SETTLE_MS = 150;
const SKIP_SECS = 10;

export type PlayTarget = { kind: "title"; id: string; version?: number } | { kind: "item"; id: number };

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
  private readonly exo: Exo = newPlayer();
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
  };
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
      if (e instanceof HttpError && e.status === 503) {
        throw new Error(t("This title's storage isn't reachable right now. Check that the NAS is on and connected."));
      }
      throw e;
    }
  }

  private load(pb: Playback, at: number) {
    this.pb = pb;
    this.offset = pb.method === "hls" ? pb.start_secs : 0;
    this.stalls.reset(Date.now());
    this.exo.setMediaItem(mediaItem(absolute(pb.url), pb.method === "hls"), pb.method === "direct_play" ? at * 1000 : 0);
    this.exo.prepare();
    this.exo.play();
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
        this.bump();
      },
    });
    this.chooseSubs(initialTrack(this.pb.subtitles, this.audioLanguage()), false);
    void features().then((f) => (this.canSearchSubs = !!f?.subtitle_search));
    this.present();
    this.timers.push(
      setInterval(() => {
        if (this.exo.isPlaying()) void this.save();
      }, SAVE_EVERY_MS),
      // Times, the timeline and subtitles follow playback; while the controls are hidden only the
      // subtitles do.
      setInterval(() => {
        if (this.s.controls[0]()) this.bump();
        this.showSubs();
      }, 250),
    );
    // Leaving the app pauses (Android stops a player in the background without a media service).
    Application.on(Application.backgroundEvent, this.onBackground);
  }

  private readonly onBackground = () => {
    this.exo.pause();
    void this.save();
  };

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
    page.on("navigatedFrom", (e: NavigatedData) => {
      if (e.isBackNavigation && !this.closed) this.close(true);
    });
    frame?.navigate({ create: () => page, animated: false });
    const w = activity.getWindow();
    w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    const c = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
    c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
    c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
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
    this.s.controls[1](true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.exo.isPlaying() && this.s.scrubAt[0]() === null) this.s.controls[1](false);
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
    if (announce) {
      const tracks = this.pb.subtitles.filter((s) => s.url);
      const i = track ? tracks.findIndex((s) => s.key === track.key) : -1;
      this.toast(i >= 0 ? t("Subtitles: {name}", { name: trackLabels(tracks)[i] }) : t("Subtitles off"));
    }
    this.showSubs();
  }

  private showSubs() {
    this.s.showing[1](this.subs ? this.subs.at(this.position() - this.s.timing[0]()) : null);
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
    return `panda.audio.${this.target.kind}.${this.target.id}`;
  }

  private savedAudio(): number | undefined {
    try {
      const v = localStorage.getItem(this.audioKey());
      return v === null ? undefined : Number(v);
    } catch {
      return undefined;
    }
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
          try {
            localStorage.setItem(this.audioKey(), String(a.index));
          } catch {
            // Not remembered without storage.
          }
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
          <gridlayout row={0} columns="auto, *" class="player-top">
            <contentview col={0} ref={(el: View) => ((el as unknown as { content: View }).content = btn("✕", () => this.close(), 22))} />
            <stacklayout col={1} class="player-titles">
              <label class="player-title" text={s.title[0]()} />
              <label class="player-stream" text={s.stream[0]()} />
            </stacklayout>
          </gridlayout>
          <stacklayout row={1} orientation="horizontal" horizontalAlignment="center" verticalAlignment="middle" class="player-center">
            <contentview ref={(el: View) => ((el as unknown as { content: View }).content = btn("↺10", () => this.seekTo(this.position() - SKIP_SECS), 24))} />
            <label
              class="player-icon big"
              text={s.playing[0]() ? "❚❚" : "▶"}
              on:tap={() => {
                if (this.exo.isPlaying()) this.exo.pause();
                else this.exo.play();
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
        <Show when={s.toast[0]()}>
          <label class="player-toast" text={s.toast[0]()} verticalAlignment="top" horizontalAlignment="center" isUserInteractionEnabled={false} />
        </Show>
      </gridlayout>
    );
  }
}

