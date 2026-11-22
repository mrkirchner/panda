// Video on Apple TV: AVPlayer in a native view under the (transparent) renderer canvas. The TV
// client reaches it through `globalThis.pandaNativeVideo` (see ../tv/devices/appletv/player.ts),
// so the client's source never imports NativeScript.
//
// AVPlayer plays HLS and MP4/MOV natively, including HEVC, HDR10, Dolby Vision and Dolby Atmos,
// which is what lets an Apple TV 4K direct-play a 4K remux the browser builds can't.
import { ContentView, type GridLayout } from "@nativescript/core";

export interface NativeVideoState {
  /** Seconds into the media. */
  time: number;
  /** Seconds; NaN until known (and for live streams). */
  duration: number;
  paused: boolean;
  /** Waiting for data while asked to play. */
  buffering: boolean;
  ended: boolean;
  /** Set once if the item fails. */
  error: string | null;
  /** End of the seekable range (a growing HLS playlist's live edge). */
  seekableEnd: number;
}

const seconds = (t: CMTime): number => {
  const s = CMTimeGetSeconds(t);
  return Number.isFinite(s) ? s : NaN;
};

export class NativeVideo {
  private player: AVPlayer | null = null;
  private layer: AVPlayerLayer | null = null;
  private readonly view = new ContentView();

  constructor(root: GridLayout) {
    // Below the canvas (index 0): the UI, subtitles and controls draw over the video.
    root.insertChild(this.view, 0);
    this.view.on("layoutChanged", () => this.fitLayer());
  }

  load(url: string, startSecs: number, autoPlay: boolean): void {
    this.stop();
    const item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(url));
    const player = AVPlayer.playerWithPlayerItem(item);
    const layer = AVPlayerLayer.playerLayerWithPlayer(player);
    layer.videoGravity = AVLayerVideoGravityResizeAspect;
    (this.view.ios as UIView).layer.addSublayer(layer);
    this.player = player;
    this.layer = layer;
    this.fitLayer();
    if (startSecs > 0) this.seek(startSecs);
    if (autoPlay) player.play();
  }

  play(): void {
    this.player?.play();
  }

  pause(): void {
    this.player?.pause();
  }

  seek(secs: number): void {
    this.player?.seekToTimeToleranceBeforeToleranceAfter(
      CMTimeMakeWithSeconds(Math.max(0, secs), 600),
      kCMTimeZero,
      kCMTimeZero,
    );
  }

  stop(): void {
    this.player?.pause();
    this.player?.replaceCurrentItemWithPlayerItem(null);
    this.layer?.removeFromSuperlayer();
    this.player = null;
    this.layer = null;
  }

  state(): NativeVideoState {
    const player = this.player;
    const item = player?.currentItem;
    if (!player || !item) {
      return { time: 0, duration: NaN, paused: true, buffering: false, ended: false, error: null, seekableEnd: 0 };
    }
    const time = seconds(player.currentTime());
    const duration = seconds(item.duration);
    let seekableEnd = 0;
    const ranges = item.seekableTimeRanges;
    if (ranges && ranges.count > 0) {
      const range = (ranges.lastObject as NSValue).CMTimeRangeValue;
      seekableEnd = seconds(range.start) + seconds(range.duration);
    }
    const failed = item.status === AVPlayerItemStatus.Failed;
    return {
      time: Number.isFinite(time) ? time : 0,
      duration,
      paused: player.rate === 0,
      buffering: player.timeControlStatus === AVPlayerTimeControlStatus.WaitingToPlayAtSpecifiedRate,
      ended: Number.isFinite(duration) && duration > 0 && player.rate === 0 && time >= duration - 0.5,
      error: failed ? (item.error?.localizedDescription ?? "playback failed") : null,
      seekableEnd: Number.isFinite(seekableEnd) ? seekableEnd : 0,
    };
  }

  private fitLayer(): void {
    const native = this.view.ios as UIView | undefined;
    if (this.layer && native) this.layer.frame = native.bounds;
  }
}

/** A preview clip's area on the client's 1920x1080 layout grid; null = the whole screen. */
interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

/**
 * Preview clips for the home hero and expanded cards (../tv/src/playback/preview.ts): a second,
 * small AVPlayer under the canvas, sized and rounded to the area the client asks for, so the
 * UI keeps drawing on top. Same shape as the browser player there.
 */
export class NativePreview {
  private player: AVPlayer | null = null;
  private layer: AVPlayerLayer | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly view = new ContentView();

  constructor(root: GridLayout) {
    root.insertChild(this.view, 0);
  }

  play(url: string, rect: PreviewRect | null, volume: number, onPlaying: () => void, onEnded: () => void): void {
    this.stop();
    const host = this.view.ios as UIView | undefined;
    if (!host) return onEnded();
    const item = AVPlayerItem.playerItemWithURL(NSURL.URLWithString(url));
    const player = AVPlayer.playerWithPlayerItem(item);
    player.volume = Math.min(1, Math.max(0, volume));
    player.muted = volume === 0;
    const layer = AVPlayerLayer.playerLayerWithPlayer(player);
    layer.videoGravity = AVLayerVideoGravityResizeAspectFill;
    layer.masksToBounds = true;
    // Layout-grid units to points: the canvas fills the screen at 1920 units wide.
    const bounds = host.bounds.size;
    const s = bounds.width / 1920 || 1;
    const r = rect ?? { x: 0, y: 0, w: 1920, h: bounds.height / s, radius: 0 };
    layer.frame = CGRectMake(r.x * s, r.y * s, r.w * s, r.h * s);
    layer.cornerRadius = r.radius * s;
    host.layer.addSublayer(layer);
    this.player = player;
    this.layer = layer;
    player.play();
    let started = false;
    this.poll = setInterval(() => {
      const t = seconds(player.currentTime());
      if (!started && player.timeControlStatus === AVPlayerTimeControlStatus.Playing && t > 0) {
        started = true;
        onPlaying();
      }
      const d = seconds(item.duration);
      if (item.status === AVPlayerItemStatus.Failed || (started && Number.isFinite(d) && t >= d - 0.25)) {
        this.stop();
        onEnded();
      }
    }, 150);
  }

  stop(): void {
    clearInterval(this.poll);
    this.poll = undefined;
    this.player?.pause();
    this.player?.replaceCurrentItemWithPlayerItem(null);
    this.layer?.removeFromSuperlayer();
    this.player = null;
    this.layer = null;
  }
}

/** What this Apple TV's display can show, for the playback profile the server plans with. */
export interface DisplayCapabilities {
  maxHeight: number;
  hdr: boolean;
  dolbyVision: boolean;
}

export function displayCapabilities(): DisplayCapabilities {
  const bounds = UIScreen.mainScreen.nativeBounds.size;
  const short = Math.min(bounds.width, bounds.height);
  const modes = AVPlayer.availableHDRModes;
  return {
    maxHeight: short >= 2160 ? 2160 : 1080,
    hdr: (modes & AVPlayerHDRMode.HDR10) !== 0,
    dolbyVision: (modes & AVPlayerHDRMode.DolbyVision) !== 0,
  };
}

/** Make the player available to the TV client. One player at a time (it's a TV). */
export function installNativeVideo(root: GridLayout): void {
  let instance: NativeVideo | null = null;
  const g = globalThis as unknown as { pandaNativeVideo: () => NativeVideo; pandaDisplay: DisplayCapabilities };
  g.pandaNativeVideo = () => (instance ??= new NativeVideo(root));
  g.pandaDisplay = displayCapabilities();
  let preview: NativePreview | null = null;
  (globalThis as unknown as { pandaNativePreview: Pick<NativePreview, "play" | "stop"> }).pandaNativePreview = {
    play: (...args) => (preview ??= new NativePreview(root)).play(...args),
    stop: () => preview?.stop(),
  };
}
