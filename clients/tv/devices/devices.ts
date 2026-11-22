import type { ClientProfile } from "../src/api/types";
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

export interface DeviceConfig {
  name: string;
  lightning?: Partial<typeof LightningConfig>;
  initialize: () => Promise<Device>;
  quality: QualityConfig;
  keys: Partial<KeyMap>;
  /** What this device plays, when the browser can't be asked (no MediaSource, e.g. Apple TV). */
  playbackProfile?: () => ClientProfile;
  /** Back on Home (top bar focused) leaves the app, as tvOS expects of Menu. */
  exitOnRootBack?: boolean;
  /** What this device can tell about Panda servers nearby (src/api/discover.ts): servers it
   * found by name (Bonjour/NSD) and/or its own address, whose network is then scanned. */
  discover?: () => Promise<{ urls: string[]; localIp?: string }>;
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
