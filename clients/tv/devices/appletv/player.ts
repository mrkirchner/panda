import type { CommonPlayer } from "#devices/common/player";

/** What the Apple TV host exposes (clients/appletv/app/video.ts): AVPlayer under the canvas. */
interface NativeVideo {
  load(url: string, startSecs: number, autoPlay: boolean): void;
  play(): void;
  pause(): void;
  seek(secs: number): void;
  stop(): void;
  state(): {
    time: number;
    duration: number;
    paused: boolean;
    buffering: boolean;
    ended: boolean;
    error: string | null;
    seekableEnd: number;
  };
}

declare global {
  // Installed by the Apple TV host before the app starts.
  var pandaNativeVideo: (() => NativeVideo) | undefined;
}

type Listener = () => void;

/**
 * The part of an HTMLVideoElement the Player page uses, backed by AVPlayer. State is polled a
 * few times a second (what `timeupdate` gives in a browser) and changes become the same events.
 */
class VideoFacade {
  crossOrigin: string | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly native: NativeVideo) {}

  get currentTime(): number {
    return this.native.state().time;
  }
  set currentTime(secs: number) {
    this.native.seek(secs);
  }
  get duration(): number {
    return this.native.state().duration;
  }
  get paused(): boolean {
    return this.native.state().paused;
  }
  get seekable() {
    const end = this.native.state().seekableEnd;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }
  play(): Promise<void> {
    this.native.play();
    return Promise.resolve();
  }
  pause(): void {
    this.native.pause();
  }
  removeAttribute(): void {}
  load(): void {}

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

/** The Apple TV player: same surface as CommonPlayer (shaka), over AVPlayer. */
export class AppleTvPlayer {
  readonly video: VideoFacade;
  onError: ((event: Event) => void) | null = null;
  onBuffering: ((buffering: boolean) => void) | null = null;
  private readonly native: NativeVideo;
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor() {
    const factory = globalThis.pandaNativeVideo;
    if (!factory) throw new Error("Apple TV video host is missing (pandaNativeVideo)");
    this.native = factory();
    this.video = new VideoFacade(this.native);
  }

  async load(url: string, opts: { autoPlay?: boolean; startTime?: number; mimeType?: string } = {}) {
    this.native.load(url, opts.startTime ?? 0, opts.autoPlay ?? false);
    this.watch();
  }

  /** Turn polled state changes into the media events the Player page listens for. */
  private watch(): void {
    clearInterval(this.poll);
    let last = { time: -1, paused: true, buffering: false, ended: false, failed: false };
    this.poll = setInterval(() => {
      const s = this.native.state();
      if (s.error && !last.failed) {
        console.error("AVPlayer error:", s.error);
        this.onError?.({ type: "error" } as Event);
      }
      if (s.paused !== last.paused) this.video.emit(s.paused ? "pause" : "play");
      if (s.buffering !== last.buffering) {
        this.onBuffering?.(s.buffering);
        this.video.emit(s.buffering ? "waiting" : "playing");
      } else if (!s.paused && !s.buffering && last.paused) {
        this.video.emit("playing");
      }
      if (s.time !== last.time) this.video.emit("timeupdate");
      if (s.ended && !last.ended) this.video.emit("ended");
      last = { time: s.time, paused: s.paused, buffering: s.buffering, ended: s.ended, failed: !!s.error };
    }, 250);
  }

  isPaused(): boolean {
    return this.video.paused;
  }
  getDuration(): number {
    return this.video.duration;
  }
  getCurrentPosition(): number {
    return this.video.currentTime;
  }
  togglePlayPause(): void {
    if (this.video.paused) this.native.play();
    else this.native.pause();
  }
  play(): void {
    this.native.play();
  }
  pause(): void {
    this.native.pause();
  }
  stop(): void {
    clearInterval(this.poll);
    this.native.stop();
  }
  seekableEnd(): number {
    const s = this.native.state();
    return s.seekableEnd || s.duration || 0;
  }
  seek(deltaSecs: number): void {
    this.native.seek(Math.max(0, this.native.state().time + deltaSecs));
  }
}

/** The device hands this out where the browser builds use CommonPlayer. */
export const asCommonPlayer = (p: AppleTvPlayer) => p as unknown as CommonPlayer;
