// tvOS has no SVG rasterizer (@nativescript/canvas-svg has no tvOS build), so the TV client's
// SVG images (icons, picture avatars, badges) are converted to PNGs at build time. The tvOS
// platform (app/app.ts) loads `foo.png` wherever the app asks for `foo.svg`; the renderer still
// scales them to the size the app draws, so they're rendered large to stay sharp.
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

/** Long edge in pixels: a little above the largest size each kind is drawn at. */
const SIZE = { avatars: 512, icons: 192, default: 256 };

module.exports = function rasterizeSvgs(srcDir, outDir) {
  let made = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.name.endsWith(".svg")) continue;
      const rel = path.relative(srcDir, file);
      const out = path.join(outDir, rel.replace(/\.svg$/, ".png"));
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) continue;
      const kind = rel.split(path.sep)[0];
      const width = SIZE[kind] ?? SIZE.default;
      const png = new Resvg(fs.readFileSync(file), { fitTo: { mode: "width", value: width } }).render().asPng();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      made++;
    }
  };
  walk(srcDir);
  if (made) console.log(`rasterize-svgs: ${made} PNG(s) in ${outDir}`);
};
