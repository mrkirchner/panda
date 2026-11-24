import type { Discovery, PlaybackProfile } from "../src/platform/types";
import type { KeyMap, Config as LightningConfig } from "@solidtv/solid";

export enum EDevicePlatform {
  CHROME = "CHROME",
  FIREFOX = "FIREFOX",
  SAFARI = "SAFARI",
  EDGE = "EDGE",
}

export enum EDeviceType {
  EMULATOR = "WEB",
  LG = "LG",
  LG_3 = "LG_3",
  LG_4 = "LG_4",
  TIZEN = "TIZEN",
  ANDROID = "ANDROID",
  APPLE_TV = "APPLE_TV",
}

export interface QualityConfig {
  image: {
    ratio: number;
    quality: number;
  };
}

/**
 * A TV platform (one folder per target here, chosen by `#device` at build time). The
 * capabilities every Panda app shares are typed by ../src/platform/types.ts; the rest is the
 * TV's own (renderer options, remote keys).
 */
export interface DeviceConfig {
  name: string;
  lightning?: Partial<typeof LightningConfig>;
  initialize: () => Promise<Device>;
  quality: QualityConfig;
  keys: Partial<KeyMap>;
  /** What this device plays, when the browser can't be asked (no MediaSource, e.g. Apple TV). */
  playbackProfile?: PlaybackProfile["profile"];
  /** Back on Home (top bar focused) leaves the app, as tvOS expects of Menu. */
  exitOnRootBack?: boolean;
  /** What this device can tell about Panda servers nearby (src/api/discover.ts): servers it
   * found by name (Bonjour/NSD) and/or its own address, whose network is then scanned. */
  discover?: Discovery["find"];
  /**
   * Keep the screen on (no screen saver, no sleep) while video plays (`on`), or let it go. Each
   * TV has its own way: Samsung's app review asks for it; Android TV and Apple TV start their
   * screen saver after a few idle minutes otherwise.
   */
  keepAwake?: (on: boolean) => void;
}

export interface Device {
  readonly type: EDeviceType;
  readonly platform: EDevicePlatform;
  readonly macAddress: string;
  readonly osVersion: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly isUHD: boolean;
  readonly canUpdate: boolean;

  closeApp(): Promise<void>;
  updateApp(): Promise<void>;
}
