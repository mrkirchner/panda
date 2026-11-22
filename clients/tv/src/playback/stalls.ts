/**
 * Detects a connection that can't keep up, so the player can drop a quality step instead of
 * stuttering. Pure (times are passed in) so it can be unit tested.
 */
export interface StallOptions {
  /** Ignore buffering right after a start or seek: that's expected. */
  graceMs: number;
  /** This many stalls within `windowMs` means the stream is too big... */
  count: number;
  windowMs: number;
  /** ...as does one stall lasting this long. */
  longMs: number;
  /** Minimum time between step-downs. */
  cooldownMs: number;
}

export const DEFAULT_STALLS: StallOptions = {
  graceMs: 3_000,
  count: 2,
  windowMs: 60_000,
  longMs: 4_000,
  cooldownMs: 30_000,
};

export class StallMonitor {
  private graceUntil = 0;
  private stalls: number[] = [];
  private stallStart: number | null = null;
  private lastStepDown = -Infinity;

  constructor(private readonly o: StallOptions = DEFAULT_STALLS) {}

  /** Playback started, restarted or seeked. */
  reset(now: number) {
    this.graceUntil = now + this.o.graceMs;
    this.stallStart = null;
  }

  /** `waiting` event. Returns true if the player should step down now. */
  waiting(now: number): boolean {
    if (now < this.graceUntil) return false;
    this.stallStart ??= now;
    this.stalls = [...this.stalls.filter(t => now - t < this.o.windowMs), now];
    return this.stalls.length >= this.o.count && this.fire(now);
  }

  /** Call ~`longMs` after a stall began. True if it's still stalled and that's too long. */
  stillWaiting(now: number): boolean {
    return this.stallStart !== null && now - this.stallStart >= this.o.longMs && this.fire(now);
  }

  /** `playing` event: the stall (if any) is over. */
  playing() {
    this.stallStart = null;
  }

  private fire(now: number): boolean {
    if (now - this.lastStepDown < this.o.cooldownMs) return false;
    this.lastStepDown = now;
    this.stalls = [];
    this.stallStart = null;
    return true;
  }
}

/** Lowest budget worth stepping down to (360p HEVC still looks acceptable here). */
export const MIN_STEP_KBPS = 600;

/** Next budget after a stall: 60% of what's streaming now, or null at the floor. */
export function stepDownBudget(currentKbps: number | null | undefined): number | null {
  if (!currentKbps || currentKbps <= MIN_STEP_KBPS) return null;
  return Math.max(MIN_STEP_KBPS, Math.floor(currentKbps * 0.6));
}
