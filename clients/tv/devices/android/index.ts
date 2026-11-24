import { DeviceConfig } from "#devices/devices";
import { config as common } from "#devices/common";
import { merge } from "lodash-es";

/**
 * Android TV / Fire TV (WebView wrapper in clients/android-tv). The wrapper turns the remote's
 * Back button into Escape, which the common key map already treats as Back.
 */
export const config: DeviceConfig = merge({}, common, <Partial<DeviceConfig>>{
  name: "android",
  // NSD in the wrapper (MainActivity.Discovery): the servers announcing `_panda._tcp`.
  discover: () => androidDiscover().then(urls => ({ urls })),
  // The wrapper's window keeps the screen on while video plays (MainActivity.Screen).
  keepAwake: (on: boolean) =>
    (globalThis as unknown as { PandaScreen?: { keepAwake(on: boolean): void } }).PandaScreen?.keepAwake(on),
});

/** Ask the wrapper to look (a few seconds); none when it can't (an older wrapper). */
function androidDiscover(): Promise<string[]> {
  type Native = { discover: (id: string) => void };
  const g = globalThis as unknown as {
    PandaNative?: Native;
    __pandaDiscovered?: (id: string, urls: string[]) => void;
  };
  if (!g.PandaNative) return Promise.resolve([]);
  return new Promise(resolve => {
    const id = String(Date.now());
    const timer = setTimeout(() => resolve([]), 10_000);
    g.__pandaDiscovered = (got, urls) => {
      if (got !== id) return;
      clearTimeout(timer);
      resolve(urls);
    };
    g.PandaNative!.discover(id);
  });
}
