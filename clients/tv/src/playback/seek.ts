/**
 * Where a seek can be served from. Direct play can jump anywhere (HTTP range requests). An HLS
 * transcode only has what ffmpeg has produced, minus what the server already deleted behind
 * the viewer, so anything outside that window restarts the transcode at the target instead.
 */
export type SeekAction = { kind: "jump"; mediaTime: number } | { kind: "restart"; at: number };

export interface SeekWindow {
  method: "direct_play" | "hls";
  /** File position where this HLS session starts (its timeline begins at 0 there). */
  offset: number;
  /** File position up to which segments exist (the playlist's live edge). */
  availableEnd: number;
  /** Current file position. */
  current: number;
  /** How far back segments are guaranteed to still exist (server keeps 120 s; keep a margin). */
  keepBehind: number;
}

/** Jumps closer than this to the live edge would immediately stall waiting for ffmpeg. */
const EDGE_MARGIN = 2;

export function planSeek(target: number, w: SeekWindow): SeekAction {
  const t = Math.max(0, target);
  if (w.method === "direct_play") return { kind: "jump", mediaTime: t };
  const inSession = t >= w.offset && t <= w.availableEnd - EDGE_MARGIN && t >= w.current - w.keepBehind;
  return inSession ? { kind: "jump", mediaTime: t - w.offset } : { kind: "restart", at: t };
}
