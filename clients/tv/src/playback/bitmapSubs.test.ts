import { describe, expect, it } from "vitest";
import { activeBitmapCue, placeImage, type BitmapCue } from "./bitmapSubs";

const img = { x: 243, y: 925, width: 1434, height: 55, url: "/a.png" };
const cues: BitmapCue[] = [
  { start: 10, end: 12, images: [img] },
  { start: 15, end: 18, images: [img] },
];

describe("bitmap subtitles", () => {
  it("finds the cue on screen", () => {
    expect(activeBitmapCue(cues, 11)?.start).toBe(10);
    expect(activeBitmapCue(cues, 16)?.start).toBe(15);
  });
  it("shows nothing between or outside cues", () => {
    expect(activeBitmapCue(cues, 13)).toBeNull();
    expect(activeBitmapCue(cues, 5)).toBeNull();
    expect(activeBitmapCue(cues, 18)).toBeNull();
    expect(activeBitmapCue([], 1)).toBeNull();
  });
  it("scales positions from the subtitle frame to the screen", () => {
    expect(placeImage(img, { video_width: 1920, video_height: 1080 })).toEqual({
      x: 243,
      y: 925,
      width: 1434,
      height: 55,
    });
    expect(placeImage(img, { video_width: 3840, video_height: 2160 }).x).toBeCloseTo(121.5);
  });
});
