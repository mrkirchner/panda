// `#device` is the build target's config (common, lg, tizen); see vite.config.js.
import { config } from "#device";
import type { DeviceCommon } from "#devices/common/device";

/** The current platform (web, LG, Tizen), initialized once and shared. */
export const device: Promise<DeviceCommon> = config.initialize();
