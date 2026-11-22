import { describe, expect, it } from "vitest";
import { displayText, formatTime, resolutionLabel } from "./format";

describe("displayText", () => {
  it("keeps accented Latin text and typographic punctuation the fonts can draw", () => {
    expect(displayText("Pokémon Detective Pikachu")).toBe("Pokémon Detective Pikachu");
    expect(displayText("¿Qué pasó? Año ñandú Łódź")).toBe("¿Qué pasó? Año ñandú Łódź");
    expect(displayText("It’s a “test” — really…")).toBe("It’s a “test” — really…");
  });
  it("falls back to base letters, and drops what can't be drawn", () => {
    expect(displayText("Việt Nam")).toBe("Viet Nam");
    expect(displayText("進撃の巨人 Attack")).toBe(" Attack");
    expect(displayText("a\u00A0b")).toBe("a b");
    expect(displayText(null)).toBe("");
  });
});

describe("resolutionLabel", () => {
  it("labels scope and full-frame encodes by width", () => {
    expect(resolutionLabel(1920, 816)).toBe("1080p");
    expect(resolutionLabel(3840, 1600)).toBe("4K");
    expect(resolutionLabel(1280, 720)).toBe("720p");
    expect(resolutionLabel(720, 480)).toBe("SD");
    expect(resolutionLabel(null, null)).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3600 + 62)).toBe("1:01:02");
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(-5)).toBe("0:00");
  });
});
