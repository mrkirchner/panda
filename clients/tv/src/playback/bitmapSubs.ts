/** Image (PGS) subtitles: a manifest of timed images from the server, drawn over the video. */

export interface BitmapImage {
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

export interface BitmapCue {
  start: number;
  end: number;
  images: BitmapImage[];
}

export interface BitmapManifest {
  /** False while the server is still extracting the track: ask again for more cues. */
  complete: boolean;
  /** The frame image positions refer to (e.g. 1920x1080). */
  video_width: number;
  video_height: number;
  cues: BitmapCue[];
}

/** The cue showing at `t` (cues are in start order), or null. */
export function activeBitmapCue(cues: BitmapCue[], t: number): BitmapCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  // Last cue starting at or before t.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const c = found >= 0 ? cues[found] : null;
  return c && t < c.end ? c : null;
}

/** Place a cue image on the 1920x1080 screen grid (the video fills the screen width). */
export function placeImage(img: BitmapImage, m: Pick<BitmapManifest, "video_width" | "video_height">) {
  const sx = 1920 / (m.video_width || 1920);
  const sy = 1080 / (m.video_height || 1080);
  return { x: img.x * sx, y: img.y * sy, width: img.width * sx, height: img.height * sy };
}
