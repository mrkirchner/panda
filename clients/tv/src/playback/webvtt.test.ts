import { describe, expect, it } from "vitest";
import { activeText, parseWebVtt } from "./webvtt";

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
<i>Hello</i> &amp; welcome

00:02.500 --> 00:04.000
Second line

01:00:00.000 --> 01:00:01.500 align:center
Late cue
`;

describe("parseWebVtt", () => {
  it("parses timings, strips tags and sorts", () => {
    const cues = parseWebVtt(VTT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: "Hello & welcome" });
    expect(cues[1].start).toBe(2.5);
    expect(cues[2].start).toBe(3600);
  });
});

describe("activeText", () => {
  const cues = parseWebVtt(VTT);
  it("finds active and overlapping cues", () => {
    expect(activeText(cues, 0.5)).toBe("");
    expect(activeText(cues, 1.5)).toBe("Hello & welcome");
    expect(activeText(cues, 2.75)).toBe("Hello & welcome\nSecond line");
    expect(activeText(cues, 3600.2)).toBe("Late cue");
    expect(activeText(cues, 5000)).toBe("");
  });
});
