import { describe, expect, it } from "vitest";
import { planSeek, type SeekWindow } from "./seek";

const hls: SeekWindow = { method: "hls", offset: 600, availableEnd: 900, current: 700, keepBehind: 90 };

describe("planSeek", () => {
  it("direct play jumps anywhere", () => {
    expect(planSeek(5000, { ...hls, method: "direct_play" })).toEqual({ kind: "jump", mediaTime: 5000 });
  });
  it("jumps within what the transcode has produced", () => {
    expect(planSeek(710, hls)).toEqual({ kind: "jump", mediaTime: 110 });
    expect(planSeek(650, hls)).toEqual({ kind: "jump", mediaTime: 50 });
  });
  it("restarts past the live edge", () => {
    expect(planSeek(899, hls)).toEqual({ kind: "restart", at: 899 });
    expect(planSeek(3000, hls)).toEqual({ kind: "restart", at: 3000 });
  });
  it("restarts before the session start or where segments were deleted", () => {
    expect(planSeek(500, hls)).toEqual({ kind: "restart", at: 500 });
    expect(planSeek(605, { ...hls, current: 800 })).toEqual({ kind: "restart", at: 605 });
  });
  it("clamps negative targets", () => {
    expect(planSeek(-30, { ...hls, method: "direct_play" })).toEqual({ kind: "jump", mediaTime: 0 });
  });
});
