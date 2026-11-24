// Subtitles for the web player: which cues show when, loaded the way the TV loads them
// (../tv/src/pages/Player.tsx): built-in text tracks window by window (`?from=<secs>`; the whole
// track takes minutes from a file on a network share), subtitle files whole, and image (PGS)
// tracks as a manifest the server fills in as it extracts them. Parsing and cue lookup are the
// TV's (`@tv/playback`).
import { api } from "@tv/api/client";
import type { SubtitleTrack } from "@tv/api/types";
import { activeBitmapCue, type BitmapCue, type BitmapManifest } from "@tv/playback/bitmapSubs";
import { activeText, parseWebVtt, type Cue } from "@tv/playback/webvtt";
import { SETTINGS, read, write, type SubtitlePref } from "@tv/platform/settings";

/** Built-in text subtitles come in windows of this many seconds (the server's SUBTITLE_WINDOW). */
const TEXT_WINDOW = 600;
/** The next window is fetched this many seconds before the current one ends. */
const TEXT_WINDOW_AHEAD = 120;
const TRACK_COMPLETE = "NOTE panda complete";
const TRACK_PENDING = "NOTE panda pending";
const PENDING_RETRY_MS = 20_000;
/** Image subtitles: the manifest is asked for again this often until it's complete. */
const BITMAP_POLL_MS = 10_000;

export type Showing =
  { kind: "text"; text: string } | { kind: "bitmap"; cue: BitmapCue; frame: BitmapManifest } | null;

export class SubtitleSource {
  private cues: Cue[] = [];
  private complete = false;
  private asked = new Set<number>();
  private manifest: BitmapManifest | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  /** `onChange`: new cues arrived (show what's current again). */
  constructor(
    readonly track: SubtitleTrack,
    private readonly onChange: () => void,
    private readonly onError: () => void,
  ) {
    const url = track.url;
    if (!url) return;
    if (track.overlay === "bitmap") void this.pollBitmap(url);
    else if (track.external) void this.loadWhole(url);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** What shows at `t` (seconds into the file). Asks for the text windows around it. */
  at(t: number): Showing {
    if (this.track.overlay === "bitmap") {
      const cue = this.manifest ? activeBitmapCue(this.manifest.cues, t) : null;
      return cue && this.manifest ? { kind: "bitmap", cue, frame: this.manifest } : null;
    }
    if (!this.track.external) this.keepWindows(t);
    const text = activeText(this.cues, t);
    return text ? { kind: "text", text } : null;
  }

  private async loadWhole(url: string) {
    const cues = parseWebVtt(await api.subtitles(url).catch(() => ""));
    if (this.closed) return;
    this.cues = cues;
    this.complete = true;
    if (!cues.length) this.onError();
    this.onChange();
  }

  private keepWindows(t: number) {
    if (this.complete || !this.track.url) return;
    const w = Math.max(0, Math.floor(t / TEXT_WINDOW) * TEXT_WINDOW);
    void this.loadWindow(w);
    if (t - w > TEXT_WINDOW - TEXT_WINDOW_AHEAD) void this.loadWindow(w + TEXT_WINDOW);
  }

  private async loadWindow(start: number) {
    const url = this.track.url;
    if (!url || this.complete || this.asked.has(start)) return;
    this.asked.add(start);
    let body: string;
    try {
      body = await api.subtitles(`${url}${url.includes("?") ? "&" : "?"}from=${start}`);
    } catch {
      this.asked.delete(start); // asked again as playback moves on
      if (!this.cues.length) this.onError();
      return;
    }
    if (this.closed || this.complete) return;
    if (body.includes(TRACK_PENDING)) {
      // Still being read from the file: ask again shortly.
      setTimeout(() => this.asked.delete(start), PENDING_RETRY_MS);
      return;
    }
    const parsed = parseWebVtt(body);
    if (body.includes(TRACK_COMPLETE)) {
      this.complete = true;
      this.cues = parsed;
    } else {
      const seen = new Set(this.cues.map((c) => `${c.start}|${c.text}`));
      this.cues = [...this.cues, ...parsed.filter((c) => !seen.has(`${c.start}|${c.text}`))].sort(
        (a, b) => a.start - b.start,
      );
    }
    this.onChange();
  }

  private async pollBitmap(url: string) {
    const m = await api.bitmapSubtitles(url).catch(() => null);
    if (this.closed) return;
    if (m) this.manifest = m;
    this.onChange();
    if (!m?.complete) this.timer = setTimeout(() => void this.pollBitmap(url), BITMAP_POLL_MS);
  }
}

// ---- Which track to show, remembered in this browser ----

type Pref = SubtitlePref;
const readPref = (): Pref | null => read(SETTINGS.webSubtitles);

/** Remember the choice (by language, so it carries over to the next title and episode). */
export function rememberSubtitles(track: SubtitleTrack | null) {
  const pref: Pref = { language: track?.language ?? null, sdh: track?.hearing_impaired ?? false };
  write(SETTINGS.webSubtitles, pref);
}

/**
 * The track to start with: your language (as last chosen; "off" stays off), else a forced track
 * in the language being heard (signs and foreign dialogue), else the file's default, else none.
 */
export function initialTrack(tracks: SubtitleTrack[], audioLanguage: string | null): SubtitleTrack | null {
  const usable = tracks.filter((t) => t.url);
  const pref = readPref();
  if (pref?.language) {
    const mine = usable.filter((t) => t.language === pref.language && !t.forced);
    const pick = mine.find((t) => t.hearing_impaired === pref.sdh) ?? mine[0];
    if (pick) return pick;
  }
  // Turned off last time: only a forced track (signs, foreign dialogue) in the language heard.
  if (pref && pref.language === null) {
    return usable.find((t) => t.forced && (!audioLanguage || t.language === audioLanguage)) ?? null;
  }
  // Else the file's own choice (as the TV picks): a forced track in the language heard, then one
  // the file marks as default.
  return (
    usable.find((t) => t.forced && (!audioLanguage || t.language === audioLanguage)) ??
    usable.find((t) => t.default) ??
    null
  );
}
