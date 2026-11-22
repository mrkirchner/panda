import type { SubtitleTrack } from "../api/types";
import { languageName } from "../format";
import { t } from "../i18n";

/** One Left/Right press in the timing panel; Up/Down move a whole second. */
export const TIMING_STEP = 0.1;
export const TIMING_MAX = 30;
const STORAGE_KEY = "panda.subtitleTiming";
/** Timings remembered (newest kept): plenty for a library, small enough for any TV. */
const REMEMBERED = 300;

/** "English (SDH, file)": the language, then what sets the track apart. */
export function trackLabel(track: SubtitleTrack): string {
  const name = languageName(track.language) ?? t("Unknown language");
  const notes = [
    track.forced ? t("Forced") : null,
    /commentary/i.test(track.title ?? "") ? t("Commentary") : null,
    track.hearing_impaired ? t("SDH") : null,
    track.external ? t("file") : null,
    track.from_version ? t("{version} version", { version: track.from_version }) : null,
  ].filter(Boolean);
  return notes.length ? `${name} (${notes.join(", ")})` : name;
}

/** Labels for a list of tracks: two that read the same get "1", "2"... after them. */
export function trackLabels(tracks: SubtitleTrack[]): string[] {
  const labels = tracks.map(trackLabel);
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return labels.map(l => {
    if ((counts.get(l) ?? 0) < 2) return l;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return `${l} ${n}`;
  });
}

/** Keep a timing within range, on whole tenths (no 0.30000000004). */
export function clampTiming(secs: number): number {
  const s = Math.round(Math.min(TIMING_MAX, Math.max(-TIMING_MAX, secs)) * 10) / 10;
  return Object.is(s, -0) ? 0 : s;
}

/** "0.3 s later" / "0.3 s earlier" / "No adjustment" (positive = shown later). */
export function describeTiming(secs: number): string {
  if (secs === 0) return t("No adjustment");
  const amount = Math.abs(secs).toFixed(1);
  return secs > 0 ? t("{secs} s later", { secs: amount }) : t("{secs} s earlier", { secs: amount });
}

/** The timing shown in the menu: "+0.3 s", "-1.2 s", "0.0 s". */
export function shortTiming(secs: number): string {
  return `${secs > 0 ? "+" : secs < 0 ? "-" : ""}${Math.abs(secs).toFixed(1)} s`;
}

type Store = Record<string, number>;

function read(): Store {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

const keyOf = (itemId: number, track: SubtitleTrack) => `${itemId}:${track.key}`;

/** The timing saved for this track of this file (a subtitle's offset belongs to the pair). */
export function savedTiming(itemId: number, track: SubtitleTrack): number {
  const v = read()[keyOf(itemId, track)];
  return typeof v === "number" && Number.isFinite(v) ? clampTiming(v) : 0;
}

export function saveTiming(itemId: number, track: SubtitleTrack, secs: number) {
  const store = read();
  const key = keyOf(itemId, track);
  delete store[key];
  if (secs !== 0) store[key] = secs;
  // Objects keep insertion order: the oldest entries come first.
  const keys = Object.keys(store);
  for (const k of keys.slice(0, Math.max(0, keys.length - REMEMBERED))) delete store[k];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Not remembered when storage is unavailable.
  }
}
