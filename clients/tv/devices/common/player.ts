import type shakaNs from "shaka-player";

export interface Player {
  isPaused(): boolean;
  getDuration(): number;
  getCurrentPosition(): number;
  play(): void;
  pause(): void;
  stop(): void;
  seek(deltaSecs: number): void;
}

/**
 * Video sits *behind* the Lightning canvas (video z-index 0, canvas 1; see index.html) so the
 * UI, subtitles and controls can be drawn
 * on top of it. Pages that play video must leave the canvas transparent where video shows.
 *
 * shaka-player is ~600 kB, so it is imported on first use rather than in the main bundle.
 */
export class CommonPlayer implements Player {
  private player: shakaNs.Player | null = null;
  readonly video: HTMLVideoElement;
  /** Called on playback errors (e.g. a segment the server already deleted). */
  onError: ((event: Event) => void) | null = null;
  /**
   * Called when buffering starts/stops. Use this rather than the video element's `waiting`
   * event: shaka handles empty buffers by setting the playback rate to 0, so the element never
   * fires `waiting` mid-stream.
   */
  onBuffering: ((buffering: boolean) => void) | null = null;

  constructor(videoElement?: HTMLVideoElement) {
    this.video = videoElement ?? CommonPlayer.createVideoElement();
  }

  private static createVideoElement(): HTMLVideoElement {
    const video = document.createElement("video");
    Object.assign(video.style, { position: "absolute", zIndex: "0", background: "#000" });
    // Exactly over the app's canvas (centered in the window, which can be any size).
    const fit = () => {
      const box = document.querySelector("canvas")?.getBoundingClientRect();
      Object.assign(video.style, {
        left: `${box?.left ?? 0}px`,
        top: `${box?.top ?? 0}px`,
        width: box ? `${box.width}px` : "100%",
        height: box ? `${box.height}px` : "100%",
      });
    };
    fit();
    window.addEventListener("resize", fit);
    video.preload = "auto";
    document.body.appendChild(video);
    return video;
  }

  private async ensurePlayer(): Promise<shakaNs.Player> {
    if (this.player) return this.player;
    const { default: shaka } = await import("shaka-player");
    shaka.polyfill.installAll();
    const player = new shaka.Player();
    await player.attach(this.video);
    player.configure({
      streaming: {
        // Modest buffer: TVs have little memory, and transcodes only run a little ahead anyway.
        bufferingGoal: 30,
        rebufferingGoal: 2,
        bufferBehind: 15,
      },
    });
    player.addEventListener("buffering", event => {
      this.onBuffering?.(Boolean((event as unknown as { buffering?: boolean }).buffering));
    });
    player.addEventListener("error", event => {
      console.error("Shaka Player error:", event);
      this.onError?.(event);
    });
    this.player = player;
    return player;
  }

  /** `mimeType` is required for URLs without a file extension (e.g. Panda's direct-play URL). */
  async load(url: string, opts: { autoPlay?: boolean; startTime?: number; mimeType?: string } = {}) {
    const player = await this.ensurePlayer();
    await player.load(url, opts.startTime, opts.mimeType);
    // Don't await play(): its promise can stay pending until data arrives. Listen for "playing" instead.
    if (opts.autoPlay) this.video.play().catch(e => console.warn("autoplay blocked:", e));
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
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  play(): void {
    void this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  stop(): void {
    void this.player?.unload();
    this.video.removeAttribute("src");
    this.video.load();
  }

  /** End of the seekable range in media time (the live edge of a growing HLS playlist). */
  seekableEnd(): number {
    const r = this.video.seekable;
    return r.length ? r.end(r.length - 1) : this.video.duration || 0;
  }

  seek(deltaSecs: number): void {
    this.video.currentTime = Math.max(0, this.video.currentTime + deltaSecs);
  }
}
