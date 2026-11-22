import { EDeviceType } from "#devices/devices";
import { DeviceCommon } from "#devices/common/device";
import { AppleTvPlayer, asCommonPlayer } from "./player";

/**
 * Apple TV: this client running in NativeScript (clients/appletv) through @solidtv/nativescript.
 * There is no browser here; the host's shims provide the globals the app uses.
 */
export class AppleTvDevice extends DeviceCommon {
  static async initialize() {
    return new AppleTvDevice(EDeviceType.APPLE_TV);
  }

  /** tvOS apps don't close themselves: Menu at the top level hands control back to the system. */
  async closeApp() {}

  /** AVPlayer (native, under the canvas) instead of shaka over a <video> element. */
  protected _getPlayer() {
    return asCommonPlayer(new AppleTvPlayer());
  }
}
