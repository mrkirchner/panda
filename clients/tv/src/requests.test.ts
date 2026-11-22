import { describe, expect, it } from "vitest";
import type { MyRequest } from "./api/types";
import { bestProgress, inFlight, requestBadge, requestLabel } from "./requests";

const req = (tiers: MyRequest["tiers"], extra: Partial<MyRequest> = {}): MyRequest => ({
  id: 1,
  kind: "movie",
  title: "The Matrix",
  year: 1999,
  tmdb_id: 603,
  poster: null,
  status: "approved",
  listed: false,
  error: null,
  tiers,
  title_id: null,
  series: null,
  ...extra,
});

describe("request status", () => {
  it("shows the furthest-along server", () => {
    const r = req([
      { tier: "hd", progress: { state: "downloading", fraction: 0.42, eta: null } },
      { tier: "4k", progress: { state: "searching", fraction: 0, eta: null } },
    ]);
    expect(bestProgress(r)?.state).toBe("downloading");
    expect(requestLabel(r)).toBe("Downloading 42%");
  });
  it("badges every state on the way, none once in the library", () => {
    const badge = (state: "searching" | "downloading" | "importing" | "available", fraction = 0) =>
      requestBadge(req([{ tier: "hd", progress: { state, fraction, eta: null } }]));
    expect(badge("downloading", 0.42)).toEqual({ label: "Downloading 42%", tone: "pending" });
    expect(badge("importing", 1)?.label).toBe("Importing");
    expect(badge("searching")?.label).toBe("Searching");
    expect(badge("available", 1)).toEqual({ label: "Downloaded", tone: "done" });
    expect(requestBadge(req([{ tier: "hd", progress: null }]))?.label).toBe("Requested");
    expect(requestBadge(req([], { title_id: "m603" }))).toBeUndefined();
  });
  it("is ready once it's in the library, and stops refreshing", () => {
    const r = req([], { title_id: "m603" });
    expect(requestLabel(r)).toBe("Ready");
    expect(inFlight(r)).toBe(false);
  });
  it("handles servers that didn't answer and failures", () => {
    expect(requestLabel(req([{ tier: "hd", progress: null }]))).toBe("Requested");
    expect(requestLabel(req([], { status: "failed" }))).toBe("Failed");
  });
});
