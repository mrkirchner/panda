import { describe, expect, it } from "vitest";
import { previewUrl } from "./trickplay";

const template = "/api/items/7/preview/{secs}?t=abc";

describe("previewUrl", () => {
  it("rounds down to the server's 10-second steps, so nearby times share a cached frame", () => {
    expect(previewUrl(template, 125.4).endsWith("/api/items/7/preview/120?t=abc")).toBe(true);
    expect(previewUrl(template, 129.9)).toBe(previewUrl(template, 120));
  });
  it("never asks for a negative time", () => {
    expect(previewUrl(template, -3).endsWith("/preview/0?t=abc")).toBe(true);
  });
});
