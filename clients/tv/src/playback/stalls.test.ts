import { describe, expect, it } from "vitest";
import { StallMonitor, stepDownBudget } from "./stalls";

describe("StallMonitor", () => {
  it("ignores buffering during the grace period after a start or seek", () => {
    const m = new StallMonitor();
    m.reset(0);
    expect(m.waiting(1_000)).toBe(false);
    expect(m.stillWaiting(2_500)).toBe(false);
  });

  it("steps down after two stalls within a minute", () => {
    const m = new StallMonitor();
    m.reset(0);
    expect(m.waiting(10_000)).toBe(false);
    m.playing();
    expect(m.waiting(30_000)).toBe(true);
  });

  it("does not count stalls further apart than the window", () => {
    const m = new StallMonitor();
    m.reset(0);
    m.waiting(10_000);
    m.playing();
    expect(m.waiting(80_000)).toBe(false);
  });

  it("steps down on one long stall, then respects the cooldown", () => {
    const m = new StallMonitor();
    m.reset(0);
    m.waiting(10_000);
    expect(m.stillWaiting(13_000)).toBe(false);
    expect(m.stillWaiting(14_000)).toBe(true);
    m.reset(15_000);
    m.waiting(20_000);
    expect(m.stillWaiting(25_000)).toBe(false); // within the 30 s cooldown
  });
});

describe("stepDownBudget", () => {
  it("drops to 60% with a floor", () => {
    expect(stepDownBudget(8_000)).toBe(4_800);
    expect(stepDownBudget(900)).toBe(600);
    expect(stepDownBudget(600)).toBeNull();
    expect(stepDownBudget(null)).toBeNull();
  });
});
