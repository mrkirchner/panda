import { beforeEach, describe, expect, it } from "vitest";
import type { NextUp } from "../api/types";
import { AUTOPLAY_LIMIT, inIntro, noteAutoplay, noteInteraction, upNext, upNextAt } from "./skips";

const next: NextUp = { item_id: 2, series: "Show", season: 1, episode: 2, title: "Two" };

describe("skip intro", () => {
  it("shows during the intro, not in its last seconds or without one", () => {
    const m = { intro_start: 60, intro_end: 95 };
    expect(inIntro(m, 59)).toBe(false);
    expect(inIntro(m, 59.6)).toBe(true);
    expect(inIntro(m, 92.9)).toBe(true);
    expect(inIntro(m, 93.5)).toBe(false);
    expect(inIntro({}, 70)).toBe(false);
    expect(inIntro(undefined, 70)).toBe(false);
  });
});

describe("up next", () => {
  beforeEach(() => noteInteraction());

  it("appears at the credits, else 20 s before the end, only with a next episode", () => {
    expect(upNextAt({ credits_start: 2500 }, 2600, next)).toBe(2500);
    // Credits too early (a mistake) or too short to count down: the fallback.
    expect(upNextAt({ credits_start: 900 }, 2600, next)).toBe(2580);
    expect(upNextAt({ credits_start: 2595 }, 2600, next)).toBe(2580);
    expect(upNextAt({}, 2600, next)).toBe(2580);
    expect(upNextAt({ credits_start: 2500 }, 2600, null)).toBe(null);
  });

  it("counts down in playback time and goes at zero", () => {
    const m = { credits_start: 2500 };
    expect(upNext(m, 2600, next, 2499, false).show).toBe(false);
    expect(upNext(m, 2600, next, 2500, false)).toEqual({ show: true, secondsLeft: 10, go: false });
    expect(upNext(m, 2600, next, 2506.5, false).secondsLeft).toBe(4);
    expect(upNext(m, 2600, next, 2510, false)).toEqual({ show: true, secondsLeft: 0, go: true });
    expect(upNext(m, 2600, next, 2505, true).show).toBe(false);
  });

  it("waits for someone after three episodes in a row started themselves", () => {
    for (let i = 0; i < AUTOPLAY_LIMIT; i++) noteAutoplay();
    expect(upNext({ credits_start: 2500 }, 2600, next, 2520, false)).toEqual({
      show: true,
      secondsLeft: null,
      go: false,
    });
    noteInteraction();
    expect(upNext({ credits_start: 2500 }, 2600, next, 2520, false).go).toBe(true);
  });
});
