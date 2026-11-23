// The web player's playback, apart from its controls: asks the server for a stream (`ClientProfile`
// from what this browser decodes, `@tv/playback/profile`), plays it in a <video> (direct play by
// its URL; HLS natively where the browser can, else through shaka-player, loaded on first use),
// and follows the TV's rules: seeks outside an HLS session's window restart it there
// (`planSeek`), long or repeated buffering steps the bitrate down (`StallMonitor`), a broken stream
// starts again where it was (three times a minute at most), progress is saved every 10 s and on
// close, and the session is stopped when it's left.
import type shakaNs from "shaka-player";
import { absolute, api, HttpError } from "@tv/api/client";
import type { ClientProfile, Item, Playback } from "@tv/api/types";
import { t } from "@tv/i18n";
import { detectProfile } from "@tv/playback/profile";
import { profileFor, savedQuality, type QualityId } from "@tv/playback/quality";
import { planSeek } from "@tv/playback/seek";
import { DEFAULT_STALLS, StallMonitor, stepDownBudget } from "@tv/playback/stalls";
import type { PlayTarget } from "./launch";

/** The server keeps HLS segments 120 s behind the viewer; seeking further back restarts. */
const KEEP_BEHIND_SECS = 90;
const SAVE_EVERY_MS = 10_000;

/** What the controls need to know, told on every change. */
export interface EngineEvents {
  /** Playing/paused/buffering changed, or a new stream started. */
  onState: () => void;
  /** Something to say over the picture. */
  onToast: (text: string) => void;
  /** It can't go on (an error that retrying won't fix). */
  onFatal: (text: string) => void;
  /** It played to the end. */
  onEnded: () => void;
}

/** This browser plays HLS itself (Safari): no need for shaka-player there. */
const nativeHls = () => {
  const v = document.createElement("video");
  return !!v.canPlayType("application/vnd.apple.mpegurl") && typeof MediaSource === "undefined";
};

export class Engine {
  pb: Playback | null = null;
  info: Item | null = null;
  private offset = 0;
  /** A restart in progress: the position it will start at. */
  private pending: number | null = null;
  quality: QualityId = savedQuality();
  audioIndex: number | undefined;
  private stallCap: number | null = null;
  private readonly stalls = new StallMonitor();
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingNow = false;
  private retries: number[] = [];
  private shaka: shakaNs.Player | null = null;
  private saveTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly profile: ClientProfile = detectProfile();

  constructor(
    readonly video: HTMLVideoElement,
    readonly target: PlayTarget,
    private readonly events: EngineEvents,
  ) {
    this.audioIndex = this.savedAudio();
    const v = video;
    v.addEventListener("waiting", () => this.watchStalls(true));
    v.addEventListener("playing", () => {
      this.watchStalls(false);
      this.events.onState();
    });
    v.addEventListener("pause", () => this.events.onState());
    v.addEventListener("play", () => this.events.onState());
    v.addEventListener("error", () => {
      if (!this.closed && this.pending === null && v.getAttribute("src")) this.recover();
    });
    v.addEventListener("ended", () => {
      const d = this.duration();
      if (d === 0 || this.position() >= d - 3) this.events.onEnded();
    });
  }

  // ---- Streams ----

  private async request(at: number): Promise<Playback> {
    const chosen = await profileFor(this.profile, this.quality);
    const profile =
      this.stallCap === null
        ? chosen
        : { ...chosen, max_bitrate_kbps: Math.min(chosen.max_bitrate_kbps ?? Infinity, this.stallCap) };
    try {
      return this.target.kind === "title"
        ? await api.playTitle(this.target.id, profile, at, this.target.version, this.audioIndex)
        : await api.startPlayback(this.target.id, profile, at, this.audioIndex);
    } catch (e) {
      // 503: the library's storage (NAS) is offline; said plainly.
      if (e instanceof HttpError && e.status === 503) {
        throw new Error(
          t("This title's storage isn't reachable right now. Check that the NAS is on and connected."),
        );
      }
      throw e;
    }
  }

  private async ensureShaka(): Promise<shakaNs.Player> {
    if (this.shaka) return this.shaka;
    const { default: shaka } = await import("shaka-player");
    shaka.polyfill.installAll();
    const player = new shaka.Player();
    await player.attach(this.video);
    player.configure({
      streaming: { bufferingGoal: 60, rebufferingGoal: 2, bufferBehind: 30 },
    });
    player.addEventListener("buffering", (e) => {
      this.watchStalls(Boolean((e as unknown as { buffering?: boolean }).buffering));
      this.events.onState();
    });
    player.addEventListener("error", () => {
      if (!this.closed && this.pending === null) this.recover();
    });
    this.shaka = player;
    return player;
  }

  private async load(pb: Playback, at: number) {
    this.pb = pb;
    this.offset = pb.method === "hls" ? pb.start_secs : 0;
    this.stalls.reset(Date.now());
    const url = absolute(pb.url);
    const v = this.video;
    if (pb.method === "direct_play" || nativeHls()) {
      if (this.shaka) await this.shaka.unload().catch(() => {});
      v.src = url;
      if (pb.method === "direct_play" && at > 0) {
        const seek = () => {
          v.currentTime = at;
        };
        if (v.readyState >= 1) seek();
        else v.addEventListener("loadedmetadata", seek, { once: true });
      }
    } else {
      const player = await this.ensureShaka();
      await player.load(url, 0, "application/x-mpegurl");
    }
    v.play().catch(() => {
      // Autoplay with sound refused (no click on the page yet): the play button starts it.
      this.events.onState();
    });
    this.events.onState();
  }

  async open(at: number) {
    this.pending = at;
    try {
      await this.load(await this.request(at), at);
    } finally {
      this.pending = null;
    }
    api.item(this.pb!.item_id).then(
      (i) => {
        this.info = i;
        this.events.onState();
      },
      () => {},
    );
    this.saveTimer = setInterval(() => {
      if (!this.video.paused) void this.save();
    }, SAVE_EVERY_MS);
  }

  /** Start again at `at` (a seek outside this stream, another audio track or quality). */
  async restart(at: number) {
    if (this.pending !== null || this.closed) return;
    const was = this.pb;
    this.pending = at;
    this.video.pause();
    this.events.onState();
    try {
      const pb = await this.request(at);
      if (this.closed) {
        if (pb.method === "hls") void api.stopSession(pb.session_id);
        return;
      }
      await this.load(pb, at);
    } catch (e) {
      this.events.onToast(e instanceof Error ? e.message : String(e));
    } finally {
      this.pending = null;
      this.events.onState();
    }
    if (was?.method === "hls") void api.stopSession(was.session_id);
  }

  // ---- Where it is ----

  /** Seconds into the file. */
  position(): number {
    if (this.pending !== null) return this.pending;
    const s = this.video.currentTime;
    return Number.isFinite(s) ? s + this.offset : this.offset;
  }

  /** The whole file's length: the server's, else what the stream says. */
  duration(): number {
    const known = this.info?.duration_secs;
    if (known) return known;
    const d = this.video.duration;
    return Number.isFinite(d) ? d + this.offset : 0;
  }

  /** End (file time) of what this stream can play right now. */
  availableEnd(): number {
    const r = this.video.seekable;
    return this.offset + (r.length ? r.end(r.length - 1) : 0);
  }

  /** File time buffered ahead of the position (for the scrubber). */
  bufferedEnd(): number {
    const b = this.video.buffered;
    const now = this.video.currentTime;
    for (let i = 0; i < b.length; i++)
      if (b.start(i) <= now + 0.5 && b.end(i) >= now) return this.offset + b.end(i);
    return this.position();
  }

  waiting(): boolean {
    return this.pending !== null || this.waitingNow || (this.video.readyState < 3 && !this.video.paused);
  }

  playing(): boolean {
    return this.pending !== null || !this.video.paused;
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
    if (action.kind === "jump") this.video.currentTime = action.mediaTime;
    else void this.restart(action.at);
  }

  togglePlay() {
    if (this.video.paused) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  // ---- When it struggles ----

  /** Buffering while playing: the TV's step-down rules (StallMonitor). */
  private watchStalls(waiting: boolean) {
    if (waiting === this.waitingNow || this.pending !== null) return;
    this.waitingNow = waiting;
    this.events.onState();
    if (!waiting) {
      this.stalls.playing();
      clearTimeout(this.stallTimer);
      return;
    }
    if (this.video.paused) return;
    if (this.stalls.waiting(Date.now())) return void this.stepDown();
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.stalls.stillWaiting(Date.now())) this.stepDown();
    }, DEFAULT_STALLS.longMs);
  }

  /** The connection can't keep up: start again at ~60% of the current bitrate. */
  private stepDown() {
    const next = stepDownBudget(this.pb?.stream.bitrate_kbps);
    if (next === null) return;
    this.stallCap = next;
    this.events.onToast(
      t("Slow connection: lowering quality to {mbps} Mbps", { mbps: (next / 1000).toFixed(1) }),
    );
    void this.restart(this.position());
  }

  /** The stream broke (a missing segment, the NAS dropping): start again where it was, a few
   * times a minute, then stop and say why. */
  private recover() {
    const now = Date.now();
    this.retries = this.retries.filter((at) => now - at < 60_000);
    if (this.retries.length >= 3) {
      this.events.onFatal(t("Playback stopped. Check that the NAS is on and connected, then try again."));
      return;
    }
    this.retries.push(now);
    void this.restart(this.position());
  }

  // ---- Choices that start the stream again ----

  /** Your audio track for this title, remembered in this browser (the TV's key). */
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

  chooseAudio(index: number) {
    this.audioIndex = index;
    try {
      localStorage.setItem(this.audioKey(), String(index));
    } catch {
      // Not remembered without storage.
    }
    void this.restart(this.position());
  }

  chooseQuality(id: QualityId) {
    this.quality = id;
    this.stallCap = null; // an explicit choice overrides step-downs
    void this.restart(this.position());
  }

  // ---- Leaving ----

  save() {
    if (!this.pb) return Promise.resolve();
    return api.progress(this.pb.item_id, this.position(), this.duration() || undefined).catch(() => {});
  }

  close() {
    if (this.closed) return;
    void this.save();
    this.closed = true;
    clearInterval(this.saveTimer);
    clearTimeout(this.stallTimer);
    this.video.pause();
    void this.shaka?.destroy().catch(() => {});
    this.video.removeAttribute("src");
    this.video.load();
    if (this.pb?.method === "hls") void api.stopSession(this.pb.session_id);
  }
}
