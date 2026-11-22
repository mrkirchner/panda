import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

// In dev, /api is proxied to the Panda server so the UI and API share one origin: session
// cookies work, and the server's same-origin (CSRF) check sees a matching Origin and Host.
const server = process.env.PANDA_SERVER ?? "http://localhost:8096";

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      // The TV app the server serves (the sidebar's "Open the TV app").
      "/tv": { target: server, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
