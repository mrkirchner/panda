import { SETTINGS, read, write } from "../src/platform/settings";

/**
 * Performance tiers. Old or small TVs (2020-and-earlier LG/Samsung, entry Fire TV sticks,
 * anything with ~2 GB of RAM) run the same app with lighter settings: 720p rendering, a smaller
 * texture budget, no animations, less preloading. Decided once at startup (renderer settings
 * can't change afterwards), from the device unless overridden.
 *
 * Override: `?tier=low|high` in the URL, or the "Performance (this TV)" setting (stored on the
 * device as `panda.tier`).
 */
export type Tier = "low" | "high";
export type TierChoice = Tier | "auto";

export interface TierSettings {
  /** Drawing resolution: 720 = draw 720p and let the TV scale it up (layout unchanged). */
  resolution: 720 | 1080 | null;
  /** Decoded texture budget before the renderer starts freeing offscreen images. */
  textureMemory: { criticalThreshold: number; targetThresholdLevel: number };
  animations: boolean;
  /** At most this many image decode workers (devices may use fewer). */
  maxImageWorkers: number;
  imageDecodeConcurrency: number;
  /** Offscreen margin to preload artwork in ([top, right, bottom, left]). */
  boundsMargin: [number, number, number, number];
  /** Extra items virtual lists keep built beyond what's visible. */
  listBuffer: number;
  /** The home hero changes title by itself (each one loads a full-screen backdrop). */
  heroAutoAdvance: boolean;
  /** Preview clips on the home hero and expanded cards (video decoding next to the UI). */
  previews: boolean;
}

export const TIERS: Record<Tier, TierSettings> = {
  high: {
    resolution: null,
    textureMemory: { criticalThreshold: 200e6, targetThresholdLevel: 0.8 },
    animations: true,
    maxImageWorkers: 2,
    imageDecodeConcurrency: 4,
    boundsMargin: [200, 700, 200, 200],
    listBuffer: 3,
    heroAutoAdvance: true,
    previews: true,
  },
  low: {
    resolution: 720,
    textureMemory: { criticalThreshold: 70e6, targetThresholdLevel: 0.6 },
    animations: false,
    maxImageWorkers: 1,
    imageDecodeConcurrency: 1,
    boundsMargin: [100, 300, 100, 100],
    listBuffer: 1,
    heroAutoAdvance: false,
    previews: false,
  },
};

/** Entry Fire TV models: Stick Lite, Stick (2nd/3rd gen), Stick 4K (1st gen), Basic Edition. */
const LOW_FIRE_TV = /\bAFT(SS|SSS|T|TM|MM|M|B|A)\b/;

/**
 * The tier for a device, from what its browser reports. Pure, for tests.
 * - LG: webOS 5 and older (2020 models and earlier) ship Chromium 68 or older.
 * - Samsung: Tizen before 6.0 (2020 models and earlier).
 * - Fire TV: the entry sticks.
 * - Anything reporting 2 GB of RAM or less, or 2 cores or fewer.
 */
export function tierFor(ua: string, deviceMemory?: number, cores?: number): Tier {
  if (/Web0S|webOS/i.test(ua)) {
    const chrome = Number(/Chrome\/(\d+)/.exec(ua)?.[1] ?? 0);
    if (chrome > 0 && chrome < 79) return "low";
  }
  const tizen = /Tizen (\d+)\.(\d+)/.exec(ua);
  if (tizen && Number(tizen[1]) < 6) return "low";
  if (LOW_FIRE_TV.test(ua)) return "low";
  if (deviceMemory !== undefined && deviceMemory <= 2) return "low";
  if (cores !== undefined && cores <= 2) return "low";
  return "high";
}

function parseChoice(value: unknown): TierChoice | null {
  return value === "low" || value === "high" || value === "auto" ? value : null;
}

/** What the person chose: URL first (testing), then the stored setting, else auto. */
export function tierChoice(): TierChoice {
  try {
    const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("tier") : null;
    const stored = read(SETTINGS.tier);
    return parseChoice(fromUrl) ?? parseChoice(stored) ?? "auto";
  } catch {
    return "auto";
  }
}

/** Save the setting; it applies on the next start. */
export function saveTierChoice(choice: TierChoice): void {
  write(SETTINGS.tier, choice === "auto" ? null : choice);
}

/** The tier this device would get on its own. */
export function detectedTier(): Tier {
  if (typeof navigator === "undefined") return "high";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  return tierFor(ua, nav.deviceMemory, nav.hardwareConcurrency || undefined);
}

const choice = tierChoice();
/** The tier this run uses. */
export const tier: Tier = choice === "auto" ? detectedTier() : choice;
export const perf: TierSettings = TIERS[tier];
