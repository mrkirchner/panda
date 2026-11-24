import { DeviceConfig } from "#devices/devices";
import { config as common } from "#devices/common";
import { merge } from "lodash-es";
import { AppleTvDevice } from "./device";

/**
 * Apple TV (clients/appletv). The Siri Remote arrives through @solidtv/nativescript's key bridge
 * as ArrowUp/Down/Left/Right, Enter, Backspace (Menu, which the common map treats as Back) and
 * MediaPlayPause.
 */
export const config: DeviceConfig = merge({}, common, <Partial<DeviceConfig>>{
  name: "appletv",
  lightning: {
    rendererOptions: {
      // The 1080p design grid at 1:1; the host's TvPlatform sizes the real surface.
      deviceLogicalPixelRatio: 1,
      devicePhysicalPixelRatio: 1,
      // No browser image workers on tvOS: decode on the main thread.
      numImageWorkers: 0,
    },
  },
  initialize: async () => AppleTvDevice.initialize(),
  // Menu on Home goes back to the Apple TV home screen.
  exitOnRootBack: true,
  // tvOS's idle timer (the screen saver) off while video plays.
  keepAwake: (on: boolean) => {
    const app = (
      globalThis as unknown as { UIApplication?: { sharedApplication: { idleTimerDisabled: boolean } } }
    ).UIApplication;
    if (app) app.sharedApplication.idleTimerDisabled = on;
  },
  // Bonjour (clients/appletv/app/discovery.ts): the servers announcing `_panda._tcp`.
  discover: async () => {
    const find = (globalThis as { pandaDiscover?: () => Promise<string[]> }).pandaDiscover;
    return { urls: find ? await find() : [] };
  },
  playbackProfile: () => {
    // From the host (clients/appletv/app/video.ts): this Apple TV's display.
    const display = (
      globalThis as { pandaDisplay?: { maxHeight: number; hdr: boolean; dolbyVision: boolean } }
    ).pandaDisplay ?? { maxHeight: 1080, hdr: false, dolbyVision: false };
    return {
      // AVPlayer plays MP4/MOV directly; anything else (MKV) is remuxed to HLS, which is cheap.
      containers: ["mp4", "mov", "m4v"],
      video_codecs: ["h264", "hevc"],
      audio_codecs: ["aac", "mp3", "ac3", "eac3", "alac", "flac"],
      max_height: display.maxHeight,
      supports_hdr: display.hdr,
      supports_dolby_vision: display.dolbyVision,
      // 5.1/7.1 and Atmos (E-AC-3) pass through to the receiver.
      max_audio_channels: 8,
    };
  },
});
// Set outright: lodash merges arrays index by index.
config.keys.PlayPause = ["MediaPlayPause", "t", 84];
