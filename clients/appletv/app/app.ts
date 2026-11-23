// Panda on Apple TV. The polyfill first (the renderer and router read browser globals at
// import), then the shims that give those globals the shape the app expects: a file: location
// into the app folder, a working history for its HashRouter, and a document its focus manager
// listens on. Then the app's own entry, unchanged: ../../tv/src/index.tsx.
import "@nativescript/canvas-polyfill";
import "@solidtv/nativescript/shims";
import { Application, Color, File, GridLayout, knownFolders, path } from "@nativescript/core";
import { isTvOS } from "@nativescript/core/platform";
import { Canvas } from "@nativescript/canvas";
import { Config, renderer } from "@solidtv/solid";
import {
  KeyBridge,
  TvPlatform,
  bindCanvas,
  bindLifecycle,
  bindRemote,
  mirrorConsole,
  type PausableRenderer,
} from "@solidtv/nativescript";
import { setDefaultPlatform } from "@solidtv/renderer/platform";
import { installNativeVideo } from "./video";
import { SETTINGS, write, type Setting } from "../../tv/src/platform/settings";
import { installDiscovery } from "./discovery";
import { installWebPDecoding } from "./webp";
import { installNativeTextInput } from "./textInput";
import { installTopShelf } from "./topShelf";

// Server artwork is WebP, which the canvas polyfill can't decode on tvOS (./webp.ts).
installWebPDecoding();

/**
 * TvPlatform hands out the on-screen Canvas view for every `createCanvas()`, but the renderer
 * also asks for canvases to rasterize SVG icons, which then resized the screen's GL surface to
 * the icon's size (72x72, stretched over the whole TV). The screen canvas goes to the renderer
 * once; later requests get an offscreen canvas from the polyfill.
 */
/** Per-try limit and tries for network images (see PandaTvPlatform.fetch). */
const IMAGE_TRY_MS = 6000;
const IMAGE_TRIES = 3;

class PandaTvPlatform extends TvPlatform {
  private screenCanvasGiven = false;

  createCanvas() {
    if (!this.screenCanvasGiven) {
      this.screenCanvasGiven = true;
      return super.createCanvas();
    }
    return document.createElement("canvas") as unknown as ReturnType<TvPlatform["createCanvas"]>;
  }

  // Bundled images are files: a query (the client's `?s=<size>` texture-cache key on avatars)
  // would be read as part of the file name and the load would come back empty.
  // Network images: tvOS's HTTP layer here occasionally never answers a request (and ignores
  // the renderer's 30 s XHR timeout), which left a tile on its loading color for good. Each try
  // gets IMAGE_TRY_MS; a stuck one is abandoned and the image requested again.
  fetch(url: string, responseType: Parameters<TvPlatform["fetch"]>[1]): Promise<unknown> {
    const remote = /^(https?:)?\/\//.test(url);
    if (!remote) return super.fetch(url.replace(/\?.*$/, ""), responseType);
    const attempt = (n: number): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          if (n + 1 < IMAGE_TRIES) resolve(attempt(n + 1));
          else reject(new Error(`no answer after ${IMAGE_TRIES} tries`));
        }, IMAGE_TRY_MS);
        super.fetch(url, responseType).then(
          r => {
            if (settled) return;
            clearTimeout(timer);
            resolve(r);
          },
          (e: unknown) => {
            if (settled) return;
            clearTimeout(timer);
            reject(e);
          },
        );
      });
    return attempt(0);
  }
}

// On a device the CLI can't stream the console: lines also go to Library/Caches/panda-log.txt.
mirrorConsole(File.fromPath(path.join(knownFolders.temp().path, "panda-log.txt")), { application: Application });

// A press a handler consumed stays with the app; Menu that nothing handled goes to the system
// (leaving the app), as tvOS expects.
Config.preventDefaultOnHandledKeys = true;

declare const __DEV__: boolean;

/** A launch environment variable (the simulator passes `SIMCTL_CHILD_<name>` through). */
const launchEnv = (name: string): string | undefined => {
  const value = NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? String(value) : undefined;
};

/**
 * Development builds only: seed the server address and a TV sign-in from the launch environment
 * (PANDA_SERVER, PANDA_DEVICE_SECRET, PANDA_TOKEN), so the simulator can skip typing them with
 * the remote. Release builds ignore these.
 */
function seedForDevelopment(): void {
  if (!__DEV__) return;
  const seeds: [string, Setting<string>][] = [
    ["PANDA_SERVER", SETTINGS.server],
    ["PANDA_DEVICE_SECRET", SETTINGS.deviceSecret],
    ["PANDA_TOKEN", SETTINGS.deviceToken],
  ];
  for (const [name, setting] of seeds) {
    const value = launchEnv(name);
    if (value) write(setting, value);
  }
}

/**
 * Development builds only: replay remote presses from PANDA_KEYS ("wait:3000 down down select
 * menu"), through the same bridge real Siri Remote presses use. For simulator testing.
 */
function replayKeys(bridge: KeyBridge): void {
  const script = __DEV__ ? launchEnv("PANDA_KEYS") : undefined;
  if (!script) return;
  const names: Record<string, string> = {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    select: "Enter",
    menu: "Backspace",
    play: "MediaPlayPause",
  };
  let at = 0;
  for (const step of script.split(/\s+/).filter(Boolean)) {
    if (step.startsWith("wait:")) {
      at += Number(step.slice(5)) || 0;
      continue;
    }
    const key = names[step] ?? step;
    setTimeout(() => {
      // tap() is false when the app handled the press (preventDefault). An unhandled Menu is
      // what a real remote hands to tvOS, which returns to the Home screen.
      const handled = bridge.tap(key) === false;
      console.log(`TEST key ${key} ${handled ? "handled" : "unhandled (a real remote passes it to tvOS)"}`);
    }, at);
    at += 250;
  }
}

/** The video layer (AVPlayer) sits under the canvas; the player adds it here. */
export const root = new GridLayout();

function boot(canvas: Canvas): void {
  seedForDevelopment();
  bindCanvas(canvas);
  setDefaultPlatform(PandaTvPlatform);
  installNativeVideo(root);
  installDiscovery();
  // Text fields use tvOS's keyboard: Siri dictation and iPhone typing (./textInput.ts).
  installNativeTextInput(root);
  const bridge = new KeyBridge({ target: document });
  bindLifecycle(() => renderer as unknown as PausableRenderer | undefined, bridge, Application);
  if (isTvOS) bindRemote(bridge, Application.ios.window);
  replayKeys(bridge);
  import("../../tv/src/index").catch((error: unknown) => console.error("Panda failed to start", error));
}

function createRootView(): GridLayout {
  root.backgroundColor = new Color("#000000");
  // Full screen: the app lays out its own title-safe margins (the 1080p design grid).
  root.iosOverflowSafeArea = true;
  const canvas = new Canvas();
  canvas.width = "100%";
  canvas.height = "100%";
  // Draw edge to edge rather than inside tvOS's title-safe insets (the layout has its own).
  canvas.iosOverflowSafeArea = true;
  canvas.on("ready", () => {
    // The plugin's ready callback swallows exceptions: log them or it's a silent blank screen.
    try {
      boot(canvas);
    } catch (error: unknown) {
      console.error("Boot failed", error);
    }
  });
  // Transparent where the app draws nothing, so the video under it shows during playback.
  canvas.backgroundColor = new Color(0, 0, 0, 0);
  root.addChild(canvas);
  return root;
}

// Top Shelf rows on the Apple TV home screen, and their links into the app (./topShelf.ts).
// Before the app starts: a launch from the Top Shelf delivers its link with the scene.
installTopShelf();
Application.run({ create: createRootView });
