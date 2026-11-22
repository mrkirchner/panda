import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import hexColorTransform from "@lightningtv/vite-hex-transform";
import legacy from "@vitejs/plugin-legacy";
import path from "path";
import deviceConfigPlugin from "./devices/deviceConfigPlugin.js";

const envDir = "./environments";

export default defineConfig(({ mode }) => {
  // Get environment variables
  // const env = loadEnv(mode, path.join(__dirname, envDir));

  return {
    envDir,
    define: {
      __DEV__: mode !== "production",
    },
    plugins: [
      deviceConfigPlugin(process.env.TARGET_DEVICE),
      hexColorTransform({
        include: ["src/**/*.{ts,tsx,js,jsx}"],
      }),
      solidPlugin({
        solid: {
          moduleName: "@solidtv/solid",
          generate: "universal",
        },
      }),
      legacy({
        targets: ["defaults", "Chrome >= 49"],
        // additionalLegacyPolyfills: ["whatwg-fetch", "es6-proxy-polyfill"],
        modernPolyfills: [
          // Safari 11 has modules, but throws > ReferenceError: Can't find variable: globalThis
          "es.global-this",
        ],
      }),
    ],
    resolve: {
      alias: {
        theme: path.resolve(__dirname, "./theme.js"),
        "@": path.resolve(__dirname, "./src"),
        "#devices": path.resolve(__dirname, "./devices"),
        // The build target's device config: TARGET_DEVICE=lg|tizen|android, else common.
        "#device": path.resolve(__dirname, "./devices", process.env.TARGET_DEVICE || "common"),
      },
      dedupe: ["solid-js", "@solidtv/solid", "@solidtv/core", "@solidtv/renderer"],
    },
    optimizeDeps: {
      exclude: ["@solidtv/solid", "@solidtv/core", "@solidtv/renderer"],
    },
    server: {
      hmr: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "devices/**/*.test.ts"],
    },
  };
});
