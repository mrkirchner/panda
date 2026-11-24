// The TV app's `#devices/resolution`: its canvas is 720p or 1080p. A browser has no canvas of
// that kind; `@tv/playback/profile` only uses this as a floor for the video size it asks for.
export type Resolution = 720 | 1080;
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;
export const resolution: Resolution = 1080;
