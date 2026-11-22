import { describe, expect, it } from "vitest";
import { browse, genresOf, indexForLetter, letterOf, matchesText, type BrowseEntry } from "./browse";

const e = (title: string, extra: Partial<BrowseEntry> = {}): BrowseEntry => ({
  key: title,
  title,
  year: null,
  rating: null,
  genres: null,
  added: "",
  ...extra,
});

describe("library browsing", () => {
  it("files titles under their letter, ignoring articles", () => {
    expect(letterOf("The Crown")).toBe("C");
    expect(letterOf("A Quiet Place")).toBe("Q");
    expect(letterOf("2001: A Space Odyssey")).toBe("#");
    expect(letterOf("alien")).toBe("A");
  });

  it("sorts A-Z without articles and jumps to the next letter that has titles", () => {
    const sorted = browse([e("Zodiac"), e("The Batman"), e("Cars"), e("2012"), e("Amelie")], {
      sort: "az",
      unwatchedOnly: false,
      genre: null,
    });
    expect(sorted.map(x => x.title)).toEqual(["2012", "Amelie", "The Batman", "Cars", "Zodiac"]);
    expect(indexForLetter(sorted, "C")).toBe(3);
    expect(indexForLetter(sorted, "D")).toBe(4); // no D: next is Z
    expect(indexForLetter(sorted, "#")).toBe(0);
  });

  it("filters by genre and unwatched, and sorts by rating/added", () => {
    const list = [
      e("Heat", { genres: "Crime, Thriller", rating: 8.3, added: "2024-01-01", watched: true }),
      e("Up", { genres: "Animation, Family", rating: 8.0, added: "2025-01-01" }),
      e("Se7en", { genres: "Crime", rating: 8.6, added: "2023-01-01" }),
    ];
    expect(genresOf(list)).toEqual(["Animation", "Crime", "Family", "Thriller"]);
    const crime = browse(list, { sort: "rating", unwatchedOnly: false, genre: "Crime" });
    expect(crime.map(x => x.title)).toEqual(["Se7en", "Heat"]);
    const unwatched = browse(list, { sort: "added", unwatchedOnly: true, genre: null });
    expect(unwatched.map(x => x.title)).toEqual(["Up", "Se7en"]);
  });

  it("filters by typed words, ignoring case, accents and punctuation", () => {
    expect(matchesText("Madagascar 3: Europe's Most Wanted", "mad 3")).toBe(true);
    expect(matchesText("Amélie", "AMELIE")).toBe(true);
    expect(matchesText("Spider-Man: No Way Home", "spider man home")).toBe(true);
    expect(matchesText("Madagascar", "mad 3")).toBe(false);
    expect(matchesText("Anything", "   ")).toBe(true);
  });

  it("sorts unwatched first, then A-Z", () => {
    const list = [
      { ...e("Zodiac"), watched: false },
      { ...e("Amelie"), watched: true },
      { ...e("Cars"), watched: false },
    ];
    const sorted = browse(list, { sort: "unwatched", unwatchedOnly: false, genre: null });
    expect(sorted.map(x => x.title)).toEqual(["Cars", "Zodiac", "Amelie"]);
  });
});
