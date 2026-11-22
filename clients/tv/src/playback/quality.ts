import { measureBandwidthKbps } from "../api/client";
import type { ClientProfile, StreamSummary } from "../api/types";

export type QualityId = "auto" | "original" | "1080" | "720" | "480";

export interface Quality {
  id: QualityId;
  label: string;
  maxHeight?: number;
  maxKbps?: number;
}

/** Fixed options use the server's H.264 ladder rates; HEVC clients get them at ~60% the bits. */
export const QUALITIES: Quality[] = [
  { id: "auto", label: "Auto" },
  { id: "original", label: "Original" },
  { id: "1080", label: "1080p  (8 Mbps)", maxHeight: 1080, maxKbps: 8_000 },
  { id: "720", label: "720p  (4 Mbps)", maxHeight: 720, maxKbps: 4_000 },
  { id: "480", label: "480p  (2 Mbps)", maxHeight: 480, maxKbps: 2_000 },
];

/** Leave headroom: other traffic and bitrate peaks shouldn't cause stalls. */
const AUTO_HEADROOM = 0.7;
/** Above this, there's no point capping (4K remux peaks are ~100 Mbps). */
const AUTO_UNLIMITED_KBPS = 150_000;
const STORAGE_KEY = "panda.quality";

export function savedQuality(): QualityId {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as QualityId | null;
    return QUALITIES.some(q => q.id === v) ? v! : "auto";
  } catch {
    return "auto";
  }
}

export function saveQuality(id: QualityId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not remembered when storage is unavailable.
  }
}

/** Apply a quality choice to the device's capability profile. */
export async function profileFor(base: ClientProfile, id: QualityId): Promise<ClientProfile> {
  if (id === "original") return base;
  if (id === "auto") {
    try {
      const budget = Math.floor((await measureBandwidthKbps()) * AUTO_HEADROOM);
      return budget >= AUTO_UNLIMITED_KBPS ? base : { ...base, max_bitrate_kbps: budget };
    } catch {
      return base; // Measurement failed: let the server decide from capabilities alone.
    }
  }
  const q = QUALITIES.find(x => x.id === id)!;
  return { ...base, max_height: Math.min(base.max_height, q.maxHeight!), max_bitrate_kbps: q.maxKbps };
}

/** "Original (direct play)" / "1080p HEVC 4.8 Mbps (videotoolbox)". ASCII only (MSDF fonts). */
export function describeStream(s: StreamSummary): string {
  if (s.mode !== "transcode") return s.mode === "direct" ? "Original (direct play)" : "Original (remux)";
  const rate = s.bitrate_kbps ? ` ${(s.bitrate_kbps / 1000).toFixed(1)} Mbps` : "";
  return `${s.height}p ${s.codec.toUpperCase()}${rate} (${s.pipeline ?? "transcode"})`;
}
