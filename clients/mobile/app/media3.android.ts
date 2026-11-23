// Media3 (ExoPlayer), the Android player behind clips and the full player (App_Resources/Android/
// app.gradle). It has no TypeScript types: the calls the app makes are typed here.
import { Utils } from "@nativescript/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
const m3 = () => (globalThis as any).androidx.media3;

/** Player states (androidx.media3.common.Player.STATE_*). */
export const STATE_IDLE = 1;
export const STATE_BUFFERING = 2;
export const STATE_READY = 3;
export const STATE_ENDED = 4;

export interface Exo {
  setMediaItem(item: unknown, startMs?: number): void;
  prepare(): void;
  play(): void;
  pause(): void;
  stop(): void;
  release(): void;
  seekTo(ms: number): void;
  setVolume(v: number): void;
  getVolume(): number;
  getCurrentPosition(): number;
  getDuration(): number;
  getBufferedPosition(): number;
  getPlaybackState(): number;
  isPlaying(): boolean;
  getPlayWhenReady(): boolean;
  setPlayWhenReady(on: boolean): void;
  setVideoTextureView(v: android.view.TextureView): void;
  addListener(l: unknown): void;
  removeListener(l: unknown): void;
  getCurrentTimeline(): { isEmpty(): boolean };
  isCurrentMediaItemLive(): boolean;
  getCurrentLiveOffset(): number;
  getContentDuration(): number;
}

export interface Listener {
  playbackState?: (state: number) => void;
  isPlaying?: (playing: boolean) => void;
  error?: (message: string) => void;
  firstFrame?: () => void;
  videoSize?: (width: number, height: number) => void;
}

export function newPlayer(): Exo {
  const ctx = Utils.android.getApplicationContext();
  return new (m3().exoplayer.ExoPlayer.Builder)(ctx).build() as Exo;
}

/** A media item for `url`; HLS by its type (the server's playlists have no .m3u8 address). */
export function mediaItem(url: string, hls: boolean): unknown {
  const b = new (m3().common.MediaItem.Builder)().setUri(url);
  if (hls) b.setMimeType("application/x-mpegURL");
  return b.build();
}

/**
 * Follow `player` and report changes. Read from the player four times a second rather than through
 * Media3's Player.Listener: NativeScript's generated implementation of that interface (all its
 * methods are Java default methods) is never called back.
 */
export function listen(player: Exo, l: Listener): () => void {
  let state = -1;
  let playing: boolean | null = null;
  let size = "";
  let shown = false;
  let lastError = "";
  const p = player as Exo & {
    getVideoSize(): { width: number; height: number; pixelWidthHeightRatio: number };
    getPlayerError(): { getMessage(): string } | null;
  };
  const check = () => {
    const st = p.getPlaybackState();
    if (st !== state) {
      state = st;
      l.playbackState?.(st);
    }
    const pl = p.isPlaying();
    if (pl !== playing) {
      playing = pl;
      l.isPlaying?.(pl);
    }
    const vs = p.getVideoSize();
    if (vs && vs.width > 0) {
      const key = `${vs.width}x${vs.height}`;
      if (key !== size) {
        size = key;
        l.videoSize?.(vs.width * (vs.pixelWidthHeightRatio || 1), vs.height);
      }
      // Frames are showing once it's playing with a known picture size.
      if (!shown && pl && p.getCurrentPosition() > 0) {
        shown = true;
        l.firstFrame?.();
      }
    }
    const err = p.getPlayerError();
    const msg = err ? String(err.getMessage?.() ?? "error") : "";
    if (msg && msg !== lastError) l.error?.(msg);
    lastError = msg;
  };
  const timer = setInterval(check, 250);
  return () => clearInterval(timer);
}

/** Scale a TextureView's picture to fill it, cropping (`cover`: clips), or to fit inside it
 * (`contain`: the player). A TextureView stretches the picture to its size otherwise. */
export function coverTexture(texture: android.view.TextureView, videoW: number, videoH: number, fit: "cover" | "contain" = "cover") {
  const w = texture.getWidth();
  const h = texture.getHeight();
  if (!w || !h || !videoW || !videoH) return;
  const scale = fit === "cover" ? Math.max(w / videoW, h / videoH) : Math.min(w / videoW, h / videoH);
  const m = new android.graphics.Matrix();
  m.setScale((videoW * scale) / w, (videoH * scale) / h, w / 2, h / 2);
  texture.setTransform(m);
}
