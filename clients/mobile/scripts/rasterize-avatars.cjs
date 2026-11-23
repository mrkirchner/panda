// The TV client's avatar pictures are SVGs (../tv/public/images/avatars), which iOS can't draw,
// so they become PNGs at build time (as clients/appletv/scripts/rasterize-svgs.cjs does for the
// Apple TV), copied into the app as images/avatars/<id>.png.
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

/** Pixels across: sharp at the largest size drawn (96 pt at 3x). */
const SIZE = 300;

module.exports = function rasterizeAvatars(srcDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let made = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith(".svg")) continue;
    const src = path.join(srcDir, name);
    const out = path.join(outDir, name.replace(/\.svg$/, ".png"));
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    fs.writeFileSync(out, new Resvg(fs.readFileSync(src), { fitTo: { mode: "width", value: SIZE } }).render().asPng());
    made++;
  }
  if (made) console.log(`rasterize-avatars: ${made} PNG(s) in ${outDir}`);
};
