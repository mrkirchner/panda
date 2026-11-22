import { EDeviceType } from "#devices/devices";
import { DeviceCommon } from "#devices/common/device";
import { TizenPlayer } from "./player";

declare const tizen: any;

export class TizenDevice extends DeviceCommon {
  static addScript(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "$WEBAPIS/webapis/webapis.js";
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error("Failed load device Script $WEBAPIS/webapis/webapis.js"));
      document.body.appendChild(script);
    });
  }

  /**
   * Samsung only delivers a remote's media and number keys to apps that register them (arrows,
   * OK and Return always arrive). Needs the tv.inputdevice privilege in config.xml.
   */
  static registerKeys() {
    const keys = [
      "MediaPlay",
      "MediaPause",
      "MediaPlayPause",
      "MediaFastForward",
      "MediaRewind",
      "MediaStop",
      "MediaTrackPrevious",
      "MediaTrackNext",
      ..."0123456789",
    ];
    try {
      tizen.tvinputdevice.registerKeyBatch(keys);
    } catch {
      // Older firmware: register one by one, skipping keys this TV doesn't have.
      for (const k of keys) {
        try {
          tizen.tvinputdevice.registerKey(k);
        } catch {
          /* not on this remote */
        }
      }
    }
  }

  static async initialize() {
    await TizenDevice.addScript();
    TizenDevice.registerKeys();
    return new TizenDevice(EDeviceType.TIZEN);
  }

  async closeApp() {
    tizen.application.getCurrentApplication().exit();
  }

  protected _getPlayer() {
    return new TizenPlayer();
  }
}
