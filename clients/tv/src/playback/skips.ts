// "Skip intro" and "Up next": when each shows, the same on every player (the TV and Apple TV,
// the web app, the phones). The server says where an episode's intro and credits are (named
// chapters, or the sound its season's episodes share) and which episode comes next.
//
// Up next appears when the credits start (or 20 s before the end when they aren't known) and,
// unless dismissed, plays the next episode after a 10 s countdown (counted in playback time, so
// pausing pauses it). After three episodes in a row started that way with nobody touching
// anything, it stops counting down: nobody may be watching.
import type { Markers, NextUp } from "../api/types";

/** Seconds of countdown before the next episode starts. */
export const COUNTDOWN_SECS = 10;
/** Without known credits, Up next shows this long before the end. */
export const FALLBACK_SECS = 20;
/** Episodes started by the countdown in a row before it waits for someone. */
export const AUTOPLAY_LIMIT = 3;

let autoplays = 0;

/** Someone pressed a key or touched the screen: the countdown may run again. */
export function noteInteraction(): void {
  autoplays = 0;
}

/** The countdown started the next episode. */
export function noteAutoplay(): void {
  autoplays += 1;
}

/** Whether Up next counts down (or waits for a press). */
export function countdownAllowed(): boolean {
  return autoplays < AUTOPLAY_LIMIT;
}

/** Whether "Skip intro" shows at `pos` (file seconds): during the intro, not in its last 2 s. */
export function inIntro(m: Markers | undefined, pos: number): boolean {
  const start = m?.intro_start;
  const end = m?.intro_end;
  if (start == null || end == null || end - start < 5) return false;
  return pos >= start - 0.5 && pos < end - 2;
}

/** Where Up next appears (file seconds), or null without a next episode or a known length. */
export function upNextAt(
  m: Markers | undefined,
  duration: number,
  next: NextUp | null | undefined,
): number | null {
  if (!next || !(duration > 60)) return null;
  const credits = m?.credits_start;
  // Credits from the second half on, leaving time to count down.
  if (credits != null && credits > duration * 0.5 && duration - credits >= COUNTDOWN_SECS) return credits;
  return duration - FALLBACK_SECS;
}

export interface UpNextState {
  /** The card is up. */
  show: boolean;
  /** Seconds left before the next episode starts (null: no countdown, it waits). */
  secondsLeft: number | null;
  /** Time to start the next episode. */
  go: boolean;
}

/** Up next at `pos`. `dismissed`: the viewer chose to watch the credits. */
export function upNext(
  m: Markers | undefined,
  duration: number,
  next: NextUp | null | undefined,
  pos: number,
  dismissed: boolean,
): UpNextState {
  const at = upNextAt(m, duration, next);
  if (at === null || pos < at || dismissed) return { show: false, secondsLeft: null, go: false };
  if (!countdownAllowed()) return { show: true, secondsLeft: null, go: false };
  const left = Math.max(0, Math.ceil(at + COUNTDOWN_SECS - pos));
  return { show: true, secondsLeft: left, go: pos >= at + COUNTDOWN_SECS };
}

/** Whether a seek back to `pos` puts Up next away again (so it shows anew later). */
export function beforeUpNext(
  m: Markers | undefined,
  duration: number,
  next: NextUp | null | undefined,
  pos: number,
): boolean {
  const at = upNextAt(m, duration, next);
  return at !== null && pos < at - 5;
}

/** "S2 E5" and the episode's name, for the card. */
export function nextLabel(n: NextUp): { heading: string; name: string } {
  return { heading: `S${n.season} E${n.episode}`, name: n.title ?? "" };
}

/** Ask again for markers the server was still finding: after these many seconds, then stop. */
export const MARKER_RETRY_SECS = [90, 240];
