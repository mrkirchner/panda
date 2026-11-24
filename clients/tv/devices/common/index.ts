import { Inspector } from "@solidtv/renderer/inspector";
import { DeviceCommon } from "./device";
import { DESIGN_HEIGHT, DESIGN_WIDTH, logicalPixelRatio, resolution } from "#devices/resolution";
import { perf } from "#devices/tier";
import { fpsInterval } from "#devices/debug";

/** The browser's screen wake lock while video plays (where it exists: Chromium, Safari, webOS). */
type Sentinel = { release(): Promise<void>; addEventListener(t: "release", fn: () => void): void };
let wakeLock: Sentinel | null = null;
let wantAwake = false;
function browserKeepAwake(on: boolean): void {
  wantAwake = on;
  const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<Sentinel> } }).wakeLock;
  if (on && !wakeLock && wl) {
    wl.request("screen").then(
      lock => {
        if (!wantAwake) return void lock.release();
        wakeLock = lock;
        lock.addEventListener("release", () => (wakeLock = null));
      },
      () => {},
    );
  } else if (!on && wakeLock) {
    void wakeLock.release();
    wakeLock = null;
  }
}

export const config = {
  name: "common",
  keepAwake: browserKeepAwake,
  quality: {
    image: {
      ratio: 1,
      quality: 80,
    },
  },
  timing: {
    hero: 500,
  },
  lightning: {
    debug: false,
    focusDebug: false,
    fontSettings: { fontFamily: "Roboto", color: 0xffffffff, fontSize: 40 },
    animationSettings: { easing: "ease-out", duration: 300 },
    rendererOptions: {
      // Layout grid; the canvas itself is this times deviceLogicalPixelRatio (720p or 1080p).
      appHeight: DESIGN_HEIGHT,
      appWidth: DESIGN_WIDTH,
      numImageWorkers: perf.maxImageWorkers,
      imageDecodeConcurrency: perf.imageDecodeConcurrency,
      inspector: import.meta.env.DEV ? Inspector : undefined,
      // 720p = 2/3, 1080p = 1. See devices/resolution.ts.
      deviceLogicalPixelRatio: logicalPixelRatio,
      // Low-tier TVs on a 1080p screen draw 720p and let the TV scale it up: the layout fills
      // the screen as before, with 44% of the pixels to fill (devices/tier.ts).
      devicePhysicalPixelRatio: perf.resolution === 720 && resolution === 1080 ? 2 / 3 : 1,
      // Preload artwork this far offscreen ([top, right, bottom, left]). Rows scroll in from the
      // right, and an open `expand` card pushes the next ones a further 400px out, so the
      // right side reaches further: otherwise posters pop in at the screen edge.
      // (Low-tier TVs preload less: see devices/tier.ts.)
      boundsMargin: perf.boundsMargin,
      createImageBitmapSupport: "auto",
      // Low-tier TVs keep much less decoded texture data resident (devices/tier.ts).
      textureMemory: perf.textureMemory,
      // Frame-rate samples for the FPS meter (devices/debug.ts); none in release builds.
      fpsUpdateInterval: fpsInterval(),
      enableClear: false,
      enableAlphaChannel: true,
      textureEnableAlphaFormats: ["png"],
    },
  },
  keys: {
    // Browsers and keyboards: b, Backspace, Escape, the browser Back key. TVs override this
    // with their remote's code (LG 461, Samsung 10009).
    Back: ["b", 66, "Backspace", 8, "Escape", 27, "BrowserBack", 166],
    Left: ["ArrowLeft", 37],
    Right: ["ArrowRight", 39],
    Up: ["ArrowUp", 38],
    Down: ["ArrowDown", 40],
    Enter: ["Enter", 13],
    Play: ["p", 80],
    Pause: ["a", 65],
    Menu: ["m"],
    // Voice search from anywhere (Search types "v" instead: it takes typed keys first).
    Voice: ["v", 86],
    // Space too, like every desktop player (Search and the Library filter type it instead:
    // they take typed keys first).
    PlayPause: ["t", 84, " ", 32],
    FastForward: ["f", 70],
    FastForward10: ["d", 68],
    Rewind: ["r", 82],
    Rewind10: ["e", 69],
    Stop: ["s", 83],
    Key0: ["0", 96, 48],
    Key1: ["1", 97, 49],
    Key2: ["2", 98, 50],
    Key3: ["3", 99, 51],
    Key4: ["4", 100, 52],
    Key5: ["5", 101, 53],
    Key6: ["6", 102, 54],
    Key7: ["7", 103, 55],
    Key8: ["8", 104, 56],
    Key9: ["9", 105, 57],
  },
  initialize: function (): Promise<DeviceCommon> {
    return DeviceCommon.initialize();
  },
};
