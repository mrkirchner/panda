import { DeviceConfig } from "#devices/devices";
import { config as common } from "#devices/common";
import { LgDevice } from "./device";
import { merge } from "lodash-es";

export const config: DeviceConfig = merge({}, common, <Partial<DeviceConfig>>{
  name: "lg",
  // webOS web apps can't browse for services: the TV's own address, whose network is scanned.
  discover: lgLocalIp,
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
    Back: 461,
    Left: 37,
    Right: 39,
    Up: 38,
    Down: 40,
    Enter: 13,
    Play: 415,
    Pause: 19,
    PlayPause: -1,
    FastForward: 417,
    FastForward10: -1,
    Rewind: 412,
    Rewind10: -1,
    Stop: 413,
    Key0: -1,
    Key1: -1,
    Key2: -1,
    Key3: -1,
    Key4: -1,
    Key5: -1,
    Key6: -1,
    Key7: -1,
    Key8: -1,
    Key9: -1,
  },
  initialize: async function () {
    return await LgDevice.initialize();
  },
});

/** The TV's address from webOS's connection manager (wired first, else Wi-Fi). */
function lgLocalIp(): Promise<{ urls: string[]; localIp?: string }> {
  return new Promise(resolve => {
    type Bridge = { onservicecallback: (msg: string) => void; call: (uri: string, params: string) => void };
    const Ctor = (globalThis as unknown as { PalmServiceBridge?: new () => Bridge }).PalmServiceBridge;
    if (!Ctor) return resolve({ urls: [] });
    const bridge = new Ctor();
    const timer = setTimeout(() => resolve({ urls: [] }), 3000);
    bridge.onservicecallback = (msg: string) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(msg) as {
          wired?: { state?: string; ipAddress?: string };
          wifi?: { state?: string; ipAddress?: string };
        };
        const ip = r.wired?.state === "connected" ? r.wired.ipAddress : r.wifi?.ipAddress;
        resolve({ urls: [], localIp: ip });
      } catch {
        resolve({ urls: [] });
      }
    };
    bridge.call("luna://com.webos.service.connectionmanager/getStatus", "{}");
  });
}
