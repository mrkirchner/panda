import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import type { Plugin } from "vite";

// Panda's web app for watching. It shares the TV app's non-UI code (API client, playback rules,
// translations) as source through `@tv`, like the phone app does; the few TV-only modules that
// code imports (`#device`, `#devices/resolution`) are answered by small stand-ins in src/shims.
//
// Two builds:
// - `pnpm build`: served by Panda at /watch/ (the server is this page's own origin; a browser
//   signed in to Panda sets itself up from that sign-in).
// - `pnpm build:standalone`: hosted anywhere (base "/", or $WATCH_BASE); asks for the server
//   address first (Connect) and signs in with a username and password.
const standalone = !!process.env.WATCH_STANDALONE;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// In dev, /api is proxied to the Panda server so the app and the API share one origin (the
// browser's Panda sign-in cookie and the server's same-origin check both work).
const server = process.env.PANDA_SERVER ?? "http://localhost:8096";

/**
 * The TV app's pictures the web app shows too (profile avatars, TMDB's logo), straight from
 * ../tv/public/images rather than copies that could drift: served in dev, emitted on build.
 */
function tvImages(): Plugin {
  const dir = here("../tv/public/images/");
  const files = [
    ...readdirSync(`${dir}avatars`)
      .filter(f => f.endsWith(".svg"))
      .map(f => `avatars/${f}`),
    "tmdb.svg",
  ];
  return {
    name: "panda-tv-images",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/images\/(avatars\/[a-z]+\.svg|tmdb\.svg)(\?.*)?$/);
        if (!m || !files.includes(m[1])) return next();
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(readFileSync(dir + m[1]));
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: "asset", fileName: `images/${f}`, source: readFileSync(dir + f) });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: standalone ? (process.env.WATCH_BASE ?? "/") : "/watch/",
  plugins: [solid(), tvImages()],
  define: {
    __DEV__: JSON.stringify(mode !== "production"),
  },
  resolve: {
    alias: [
      { find: /^@tv\//, replacement: here("../tv/src/") },
      { find: /^#devices\/debug$/, replacement: here("../tv/devices/debug.ts") },
      { find: /^#devices\/resolution$/, replacement: here("./src/shims/resolution.ts") },
      { find: /^#device$/, replacement: here("./src/shims/device.ts") },
    ],
    // The shared TV code imports "solid-js" from ../tv, whose own copy is Solid 1: always use
    // this app's Solid 2, one instance.
    dedupe: ["solid-js"],
  },
  server: {
    port: 5175,
    proxy: {
      "/api": { target: server, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // shaka-player (~750 kB) is its own chunk, loaded only when a stream needs it.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
