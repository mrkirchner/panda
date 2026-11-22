import { Config as LightningConfig } from "@solidtv/solid";
import { createContext, createSignal, useContext } from "solid-js";

/** Longest a page stays hidden while it puts things back. */
const RESTORE_MAX_MS = 2500;

/**
 * Where focus was on each page, so Back lands on the tile you left from: per page address,
 * the focused row and the focused card in each row (or a grid's title, sort and filter). Only a return by Back restores it; a page
 * opened any other way starts at the top (and forgets what was saved for it).
 */
const saved = new Map<string, Map<string, unknown>>();
/** Page addresses kept (oldest dropped): a long session doesn't grow this forever. */
const MAX_PAGES = 30;
let returning = false;

/** The app's Back: the page about to show should come back where it was. */
export function markReturn() {
  returning = true;
  // Only for the page Back shows (pages that keep no positions never take it).
  clearTimeout(expiry);
  expiry = setTimeout(() => (returning = false), 1000);
}
let expiry: ReturnType<typeof setTimeout> | undefined;

/** One page's positions: `get` what to restore (only after Back), `set` as focus moves.
 * `begin` marks a restore under way (the page stays hidden until every one has `end`ed). */
export interface Positions {
  get: <T = number>(slot: string) => T | undefined;
  set: (slot: string, value: unknown) => void;
  begin: () => () => void;
  /** Restores still under way. */
  busy: () => boolean;
}

/** Positions for the page at `address`, mounting now. */
export function positionsFor(address: string): Positions {
  const restore = returning;
  returning = false;
  if (!restore) saved.delete(address);
  let slots = saved.get(address);
  if (!slots) {
    slots = new Map();
    saved.set(address, slots);
    if (saved.size > MAX_PAGES) saved.delete(saved.keys().next().value!);
  }
  const at = slots;
  // What to restore is read once per slot (a row rebuilt later starts from where it is).
  const pending = restore ? new Map(at) : new Map<string, unknown>();
  const [open, setOpen] = createSignal(0);
  return {
    begin: () => {
      setOpen(n => n + 1);
      let done = false;
      // Never stuck hidden: a restore that can't finish lets the page show anyway.
      const timer = setTimeout(() => end(), RESTORE_MAX_MS);
      const end = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setOpen(n => n - 1);
      };
      return end;
    },
    busy: () => open() > 0,
    get: <T>(slot: string) => {
      const v = pending.get(slot) as T | undefined;
      pending.delete(slot);
      return v;
    },
    set: (slot, value) => {
      at.set(slot, value);
    },
  };
}

/** The positions of the page around a row (PageRows provides them). */
export const PositionsContext = createContext<Positions | undefined>();
export const usePositions = () => useContext(PositionsContext);

/** Restores in progress: animations stay off until the last one is done. */
let holds = 0;
let animationsWere = true;
let release: ReturnType<typeof setTimeout> | undefined;

/**
 * Animations off until the returned function is called: a page coming back by Back appears
 * where it was (scrolled, card in place, background dimmed) instead of sliding there.
 */
export function holdAnimations(): () => void {
  if (holds++ === 0) {
    clearTimeout(release);
    animationsWere = LightningConfig.animationsEnabled;
    LightningConfig.animationsEnabled = false;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holds === 0) {
      // A moment for the last jumps to draw before transitions come back.
      release = setTimeout(() => {
        if (holds === 0) LightningConfig.animationsEnabled = animationsWere;
      }, 150);
    }
  };
}

/** Run one jump of a restore with animations off. */
export function instantly(jump: () => void) {
  const end = holdAnimations();
  try {
    jump();
  } finally {
    end();
  }
}
