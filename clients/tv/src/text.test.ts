import { describe, expect, it } from "vitest";
import { fold, normalized, TYPABLE } from "./text";

describe("text folding", () => {
  it("strips accents and punctuation, lowercases", () => {
    expect(fold("Amélie")).toBe("amelie");
    expect(fold("Spider-Man: No Way Home")).toBe("spider man no way home");
    expect(fold("  WALL·E  ")).toBe("wall e");
    expect(fold("Pokémon 2000")).toBe("pokemon 2000");
  });
  it("keeps non-Latin scripts", () => {
    expect(fold("Амели")).toBe("амели");
    expect(fold("千と千尋の神隠し")).toBe("千と千尋の神隠し");
  });
  it("normalizes when available and passes through otherwise", () => {
    expect(normalized("é", "NFD").length).toBe(2);
  });
  it("knows typable characters", () => {
    expect(TYPABLE.test("a")).toBe(true);
    expect(TYPABLE.test("Ж")).toBe(true);
    expect(TYPABLE.test("!")).toBe(true);
    expect(TYPABLE.test("\n")).toBe(false);
  });
});
