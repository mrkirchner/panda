import { describe, expect, it } from "vitest";
import { audioLabels } from "./audio";

const track = (language: string | null, channels: number, codec = "aac") => ({
  index: 0,
  language,
  codec,
  channels,
  default: false,
});

describe("audioLabels", () => {
  it("says the language and layout", () => {
    expect(audioLabels([track("en", 6), track("fr", 2)])).toEqual(["English (5.1)", "French (Stereo)"]);
  });
  it("marks a commentary track", () => {
    expect(
      audioLabels([
        { ...track("en", 6), title: "Main" },
        { ...track("en", 2), title: "Director's Commentary" },
      ]),
    ).toEqual(["English (5.1)", "English (Stereo, Commentary)"]);
  });
  it("tells apart tracks that read the same by codec, then by number", () => {
    expect(audioLabels([track("en", 6, "truehd"), track("en", 6, "ac3")])).toEqual([
      "English (5.1, Dolby TrueHD)",
      "English (5.1, Dolby Digital)",
    ]);
    expect(audioLabels([track("en", 2), track("en", 2)])).toEqual([
      "English (Stereo, AAC) 1",
      "English (Stereo, AAC) 2",
    ]);
  });
});
