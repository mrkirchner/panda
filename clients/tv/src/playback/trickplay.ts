import { absolute } from "../api/client";

/** Previews exist per this many seconds (the server rounds down the same way and caches). */
export const PREVIEW_STEP_SECS = 10;

/** The preview image for `secs`, from playback's `preview_url` template (`{secs}`). */
export function previewUrl(template: string, secs: number): string {
  const step = Math.max(0, Math.floor(secs / PREVIEW_STEP_SECS) * PREVIEW_STEP_SECS);
  return absolute(template.replace("{secs}", String(step)));
}
