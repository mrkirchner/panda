import { describe, expect, it } from "vitest";
import { suggest } from "./suggest";

const titles = [
  "Star Wars",
  "Star Trek Beyond",
  "The Matrix",
  "Matrix Reloaded",
  "Lodestar",
  "Amélie",
  "Star Wars",
];

describe("suggest", () => {
  it("puts titles starting with the text first, shortest first", () => {
    expect(suggest(titles, "star")).toEqual(["Star Wars", "Star Trek Beyond"]);
  });
  it("ignores a leading 'the' and finds later words", () => {
    expect(suggest(titles, "matr")).toEqual(["Matrix Reloaded", "The Matrix"]);
    expect(suggest(titles, "wars")).toEqual(["Star Wars"]);
  });
  it("needs every typed word, the last one as a prefix", () => {
    expect(suggest(titles, "star tr")).toEqual(["Star Trek Beyond"]);
    expect(suggest(titles, "star x")).toEqual([]);
  });
  it("ignores accents and case, and returns nothing for nothing", () => {
    expect(suggest(titles, "AMEL")).toEqual(["Amélie"]);
    expect(suggest(titles, "  ")).toEqual([]);
  });
});
