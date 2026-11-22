import { DeviceConfig } from "#devices/devices";
import { merge } from "lodash-es";
import { config as common } from "#devices/common";
import { TizenDevice } from "./device";

export const config: DeviceConfig = merge({}, common, <Partial<DeviceConfig>>{
  name: "tizen",
  // Tizen web apps can't browse for services: the TV's own address, whose network is scanned.
  discover: async () => {
    const net = (globalThis as unknown as { webapis?: { network?: { getIp?: () => string } } }).webapis
      ?.network;
    try {
      return { urls: [], localIp: net?.getIp?.() || undefined };
    } catch {
      return { urls: [] };
    }
  },
  quality: {
    image: {
      ratio: 0.1,
      quality: 1,
    },
  },
  lightning: {
    rendererOptions: {
      numImageWorkers: 0,
    },
  },
  keys: {
    Back: 10009,
    Left: 37,
    Right: 39,
    Up: 38,
    Down: 40,
    Enter: 13,
    Play: 415,
    Pause: 19,
    PlayPause: 10252,
    FastForward: 417,
    FastForward10: 10233,
    Rewind: 412,
    Rewind10: 10232,
    Stop: 413,
    Key0: 48,
    Key1: 49,
    Key2: 50,
    Key3: 51,
    Key4: 52,
    Key5: 53,
    Key6: 54,
    Key7: 55,
    Key8: 56,
    Key9: 57,
  },
  initialize: async function () {
    return await TizenDevice.initialize();
  },
});
