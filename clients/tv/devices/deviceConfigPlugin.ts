import { Plugin } from "vite";

/**
 * Per-device build output. The device config itself is chosen by the `#device` alias in
 * vite.config.js. Packaged apps load from local files, so device builds use relative paths.
 */
export default (device: string | undefined): Plugin => ({
  name: "device-config",
  enforce: "pre",
  config: config => {
    config.build = config.build ?? {};
    config.build.outDir ??= `dist/${device ?? "common"}`;
    config.base ??= device ? "./" : "/common/";
  },
});
