const path = require("path");
const webpack = require("@nativescript/webpack");

// The phone app's screens live in app/; the API, sign-in and playback logic are the TV client's
// (../tv/src), shared as source like the Apple TV build does. @nativescript-community/solid-js
// registers its own webpack setup (Solid's universal JSX compiler) from its package.
const TV = path.resolve(__dirname, "../tv/src");
// The Apple TV host's native helpers that work on iPhone too (Bonjour discovery).
const APPLETV = path.resolve(__dirname, "../appletv/app");

module.exports = env => {
  webpack.init(env);
  webpack.chainWebpack(config => {
    config.resolve.alias.set("@tv", TV);
    config.resolve.alias.set("@appletv", APPLETV);
    config.resolve.alias.set("#device", path.resolve(__dirname, "app/shims/device.ts"));
    // The TV code's device-specific imports, answered for the phone.
    config.resolve.alias.set("#devices/debug", path.resolve(__dirname, "app/shims/debug.ts"));
    // TV sources are compiled like the app's own (they're outside app/, so add them).
    config.module.rule("bundle-source").include.add(path.resolve(__dirname, "app")).add(TV).add(APPLETV);
    config.plugin("DefinePlugin").tap(args => {
      Object.assign(args[0], {
        "import.meta.env.VITE_SERVED_BY_PANDA": "undefined",
        "import.meta.env.VITE_PANDA_SERVER": JSON.stringify(process.env.PANDA_SERVER ?? ""),
        "import.meta.env.DEV": JSON.stringify(!env.production),
      });
      return args;
    });
    config.plugins.delete("ForkTsCheckerWebpackPlugin");
  });
  return webpack.resolveConfig();
};
