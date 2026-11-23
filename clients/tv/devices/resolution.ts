import { SETTINGS, read, write } from "../src/platform/settings";

/**
 * Output resolution. The UI is always laid out on a 1920x1080 grid (`src/theme.ts`); the
 * renderer scales that grid to the chosen resolution via `deviceLogicalPixelRatio`, so there
 * is one layout and it renders natively (no CSS scaling, text stays crisp).
 *
 * - 1080p: viewport fits a full 1920x1080 canvas.
 * - 720p: anything smaller (most 720p panels and many TV browsers report 1280x720).
 *
 * Override for testing with `?res=720` / `?res=1080` in the URL, `VITE_RESOLUTION`, or the
 * admin Debug page (stored on the device as `panda.res`; applies on restart).
 */
export type Resolution = 720 | 1080;

export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

const RATIO: Record<Resolution, number> = { 720: 2 / 3, 1080: 1 };

function parse(value: string | null | undefined): Resolution | null {
  const n = Number(String(value ?? "").replace(/p$/i, ""));
  return n === 720 || n === 1080 ? n : null;
}

/** The stored override (Debug page), if any. */
export function storedResolution(): Resolution | null {
  return parse(read(SETTINGS.resolution));
}

/** Save an override (`null`: automatic); it applies on the next start. */
export function saveResolution(res: Resolution | null): void {
  write(SETTINGS.resolution, res === null ? null : res === 720 ? "720" : "1080");
}

/** What the screen itself would get. */
export function autoResolution(): Resolution {
  // A pixel of slack for browsers that report 1919x1079.
  return window.innerWidth >= DESIGN_WIDTH - 2 && window.innerHeight >= DESIGN_HEIGHT - 2 ? 1080 : 720;
}

export function detectResolution(): Resolution {
  const fromUrl = parse(new URLSearchParams(location.search).get("res"));
  const fromEnv = parse(import.meta.env.VITE_RESOLUTION);
  const chosen = fromUrl ?? fromEnv ?? storedResolution();
  if (chosen) return chosen;
  return autoResolution();
}

export const resolution: Resolution = detectResolution();

/** Scale from the 1920x1080 design grid to the output resolution. */
export const logicalPixelRatio = RATIO[resolution];

if (import.meta.env.DEV) {
  console.info(`[panda] rendering at ${resolution}p (scale ${logicalPixelRatio.toFixed(3)})`);
}
