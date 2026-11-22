const path = require("path");
const webpack = require("@nativescript/webpack");
const { chainSolidTV } = require("@solidtv/nativescript/webpack");

// The app is ../tv (its src and devices), the same source as the web/TV builds; this project
// only bundles it for the tvOS runtime and adds what the bundle needs around it.
const TV = path.resolve(__dirname, "../tv");
const SRC = path.join(TV, "src");
const DEVICES = path.join(TV, "devices");
const EMPTY = path.resolve(__dirname, "stubs/empty.cjs");
// SVG images as PNGs for tvOS (see scripts/rasterize-svgs.cjs).
const RASTER = path.resolve(__dirname, "platforms/raster-images");
require("./scripts/rasterize-svgs.cjs")(path.join(TV, "public/images"), RASTER);

module.exports = env => {
  webpack.init(env);
  webpack.chainWebpack(config => {
    chainSolidTV(config, {
      hexColors: { include: [SRC, DEVICES] },
      // vite's import.meta.env for the app (the server address comes from the Connect screen).
      env: {
        BASE_URL: "./",
        DEV: false,
        PROD: true,
        MODE: "production",
        VITE_PANDA_SERVER: "",
        VITE_RESOLUTION: "",
        // Debug builds (scripts/run-device.sh, the simulator) show the FPS meter; --release doesn't.
        VITE_SHOW_FPS: env.production ? "" : "1",
      },
      alias: {
        "@": SRC,
        "#devices": DEVICES,
        // This build's device config.
        "#device": path.join(DEVICES, "appletv"),
        // Browser-only; tvOS plays video with AVPlayer.
        "shaka-player": EMPTY,
      },
    });
    // Image paths: .svg -> the build-time PNGs (tvOS can't rasterize SVG).
    config.module
      .rule("svg-paths-to-png")
      .test(/\.(ts|tsx|js|jsx)$/)
      .include.add(SRC)
      .end()
      .use("svg-to-png")
      .loader(path.resolve(__dirname, "scripts/svg-to-png-loader.cjs"));
    // The web build does no type check either (vite only transpiles); `pnpm typecheck` in
    // ../tv is the type check.
    config.plugins.delete("ForkTsCheckerWebpackPlugin");
    config.set("ignoreWarnings", [{ message: /not found in 'shaka-player'/ }]);
    // The fonts and images the web build serves from public/, at the relative paths it uses.
    config.plugin("CopyWebpackPlugin").tap(args => {
      args[0].patterns.push(
        { from: path.join(TV, "public/fonts"), to: "fonts", noErrorOnMissing: true },
        { from: path.join(TV, "public/images"), to: "images", noErrorOnMissing: true },
        { from: RASTER, to: "images", noErrorOnMissing: true },
      );
      return args;
    });
  });
  return webpack.resolveConfig();
};
