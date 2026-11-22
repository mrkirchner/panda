import { beforeEach, describe, expect, it } from "vitest";
import type { SubtitleTrack } from "../api/types";
import {
  clampTiming,
  describeTiming,
  savedTiming,
  saveTiming,
  shortTiming,
  trackLabel,
  trackLabels,
} from "./subtitles";

const track = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  index: 2,
  key: "s2",
  language: "eng",
  codec: "subrip",
  default: false,
  forced: false,
  hearing_impaired: false,
  external: false,
  overlay: "text",
  url: "/x",
  ...over,
});

describe("labels", () => {
  it("names the language and what sets a track apart", () => {
    expect(trackLabel(track())).toBe("English");
    expect(trackLabel(track({ language: "en", hearing_impaired: true, external: true }))).toBe(
      "English (SDH, file)",
    );
    expect(trackLabel(track({ forced: true }))).toBe("English (Forced)");
    expect(trackLabel(track({ language: null }))).toBe("Unknown language");
  });

  it("numbers tracks that would read the same", () => {
    expect(trackLabels([track(), track({ key: "s3" }), track({ language: "spa" })])).toEqual([
      "English 1",
      "English 2",
      "Spanish",
    ]);
  });
});

describe("timing", () => {
  it("stays on tenths within range", () => {
    expect(clampTiming(0.1 + 0.2)).toBe(0.3);
    expect(clampTiming(-0.04)).toBe(0);
    expect(Object.is(clampTiming(-0.04), -0)).toBe(false);
    expect(clampTiming(99)).toBe(30);
    expect(clampTiming(-99)).toBe(-30);
  });

  it("describes the direction", () => {
    expect(describeTiming(0)).toBe("No adjustment");
    expect(describeTiming(0.3)).toBe("0.3 s later");
    expect(describeTiming(-1.5)).toBe("1.5 s earlier");
    expect(shortTiming(0.3)).toBe("+0.3 s");
    expect(shortTiming(-1)).toBe("-1.0 s");
    expect(shortTiming(0)).toBe("0.0 s");
  });

  describe("remembered per file and track", () => {
    beforeEach(() => {
      const data = new Map<string, string>();
      globalThis.localStorage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      } as Storage;
    });

    it("saves, reads back and forgets a reset", () => {
      saveTiming(7, track(), 0.4);
      expect(savedTiming(7, track())).toBe(0.4);
      expect(savedTiming(7, track({ key: "fabc" }))).toBe(0);
      expect(savedTiming(8, track())).toBe(0);
      saveTiming(7, track(), 0);
      expect(localStorage.getItem("panda.subtitleTiming")).toBe("{}");
    });

    it("keeps only the newest few hundred", () => {
      for (let i = 0; i < 305; i++) saveTiming(i, track(), 1);
      expect(savedTiming(0, track())).toBe(0);
      expect(savedTiming(304, track())).toBe(1);
      expect(Object.keys(JSON.parse(localStorage.getItem("panda.subtitleTiming")!))).toHaveLength(300);
    });

    it("survives junk in storage", () => {
      localStorage.setItem("panda.subtitleTiming", "not json");
      expect(savedTiming(1, track())).toBe(0);
    });
  });
});
