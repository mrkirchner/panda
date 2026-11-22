import { describe, expect, it, vi } from "vitest";

// The real client reads browser globals at import; Auto's measurement is stubbed here.
vi.mock("../api/client", () => ({ measureBandwidthKbps: vi.fn(async () => 20_000) }));

import { describeStream, profileFor } from "./quality";
import type { ClientProfile } from "../api/types";

const base: ClientProfile = {
  containers: ["mp4"],
  video_codecs: ["h264", "hevc"],
  audio_codecs: ["aac"],
  max_height: 2160,
  supports_hdr: true,
  supports_dolby_vision: false,
  max_audio_channels: 2,
};

describe("profileFor", () => {
  it("original leaves the profile uncapped", async () => {
    expect(await profileFor(base, "original")).toEqual(base);
  });
  it("fixed qualities cap height and bitrate", async () => {
    const p = await profileFor(base, "720");
    expect(p.max_height).toBe(720);
    expect(p.max_bitrate_kbps).toBe(4000);
  });
});

describe("auto", () => {
  it("budgets 70% of the measured connection", async () => {
    expect((await profileFor(base, "auto")).max_bitrate_kbps).toBe(14_000);
  });
});

describe("describeStream", () => {
  it("labels direct play and transcodes", () => {
    expect(
      describeStream({ mode: "direct", codec: "hevc", height: 2160, bitrate_kbps: 40000, pipeline: null }),
    ).toBe("Original (direct play)");
    expect(
      describeStream({
        mode: "transcode",
        codec: "hevc",
        height: 1080,
        bitrate_kbps: 4800,
        pipeline: "videotoolbox",
      }),
    ).toBe("1080p HEVC 4.8 Mbps (videotoolbox)");
  });
});
