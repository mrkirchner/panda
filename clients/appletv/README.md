# Panda for Apple TV

The NativeScript host that runs the TV client (`../tv`) on tvOS. See `../../docs/DEVICES.md`
(Apple TV) for setup, simulator runs and installing on a device.

- `app/app.ts`: boot (polyfill, shims, Siri Remote bridge, lifecycle), the tvOS render platform,
  development launch hooks.
- `webpack.config.js`: bundles `../tv/src` with `#device` = `../tv/devices/appletv`.
- `scripts/rasterize-svgs.cjs`, `scripts/svg-to-png-loader.cjs`: SVG images as PNGs (tvOS has no
  SVG rasterizer).
