// Keeping the screen on while video plays: each TV's own way (DeviceConfig.keepAwake).
import { config } from "#device";
import type { DeviceConfig } from "#devices/devices";

export function keepAwake(on: boolean): void {
  try {
    (config as unknown as Pick<DeviceConfig, "keepAwake">).keepAwake?.(on);
  } catch {
    // Never let a TV API break playback.
  }
}
