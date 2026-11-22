import { describe, expect, it } from "vitest";
import { formatBytes, ago, passwordProblem, until } from "./format";

describe("ago/until", () => {
  const now = 1_800_000_000;
  it("formats relative times", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago(now - 30, now)).toBe("just now");
    expect(ago(now - 120, now)).toBe("2 minutes ago");
    expect(ago(now - 3 * 86400, now)).toBe("3 days ago");
    expect(until(now + 86400, now)).toBe("in 1 day");
    expect(until(now + 7 * 86400, now)).toBe("in 7 days");
  });
});

describe("passwordProblem", () => {
  it("mirrors the server policy", () => {
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem("long enough pw")).toBeNull();
    expect(passwordProblem("long enough pw", "different!!")).toMatch(/match/);
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_800_000_000_000)).toBe("1.8 TB");
    expect(formatBytes(512_000_000_000)).toBe("512 GB");
  });
});
