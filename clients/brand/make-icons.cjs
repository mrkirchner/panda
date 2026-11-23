// Renders every app's icons from the logo sources in this folder:
//   panda-mark.svg      the mark: a panda in front of a play triangle (groups #play and #panda)
//   panda-wordmark.svg  "Panda" in Fredoka Bold as outlines (no font needed), a play in the "a"
// Run: pnpm install && pnpm icons   (the outputs are committed; rerun after changing the logo)
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const CLIENTS = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(__dirname, name), "utf8");
const MARK = read("panda-mark.svg");
const WORDMARK = read("panda-wordmark.svg");
const viewBox = svg => svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const inner = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const DEFS = MARK.match(/<defs>[\s\S]*?<\/defs>/)[0];
const group = id => MARK.match(new RegExp(`<g id="${id}">[\\s\\S]*?</g>`))[0];
/** The play triangle's outline, from the mark (so the glow follows it if it's reshaped). */
const PLAY_PATH = group("play").match(/<path[^>]*\sd="([^"]+)"/)[1];
const [MX, MY, MW, MH] = viewBox(MARK);
const [WX, WY, WW, WH] = viewBox(WORDMARK);

// Palette: clients/tv/src/theme.ts, plus the logo's orange.
const BG_TOP = "#1d1b1c";
const BG = "#0b0b0d";
const ORANGE = "#ff6a00";

/** Parts of the mark (`play`, `panda` or both) at (x, y), `size` px square. */
const mark = (x, y, size, parts = ["play", "panda"]) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${MX} ${MY} ${MW} ${MH}">${DEFS}${parts.map(group).join("")}</svg>`;
/** The play triangle's glow, under the mark. */
const glow = (x, y, size) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${MX} ${MY} ${MW} ${MH}" overflow="visible">
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter>
    <path d="${PLAY_PATH}" fill="none" stroke="${ORANGE}" stroke-opacity="0.55" stroke-width="40" stroke-linejoin="round" filter="url(#glow)"/>
  </svg>`;
/** The wordmark, `height` px tall (its cap height plus margin), left edge at x. */
const wordmark = (x, y, height) => {
  const width = (WW / WH) * height;
  return { width, svg: `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${WX} ${WY} ${WW} ${WH}">${inner(WORDMARK)}</svg>` };
};
/** Dark background with a warm glow at the top left, like the app's screens. */
const background = (w, h, radius = 0) => `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${BG_TOP}"/><stop offset="1" stop-color="${BG}"/></linearGradient>
    <radialGradient id="warm" cx="0.2" cy="0.15" r="0.75"><stop offset="0" stop-color="#ff8c1e" stop-opacity="0.30"/><stop offset="1" stop-color="#ff8c1e" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="${radius}" fill="url(#bg)"/><rect width="${w}" height="${h}" rx="${radius}" fill="url(#warm)"/>`;
const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** Square icon: the mark centered on the dark background, `fill` of the side. */
const squareIcon = (size, { radius = 0, fill = 0.78 } = {}) => {
  const m = size * fill, o = (size - m) / 2;
  return svgDoc(size, size, background(size, size, radius) + glow(o, o, m) + mark(o, o, m));
};
/** Wide banner: mark then wordmark, centered as a group. */
const banner = (w, h, { markFill = 0.5, textFill = 0.22 } = {}) => {
  const m = h * markFill, gap = m * 0.08;
  const text = wordmark(0, 0, h * textFill);
  const x = (w - (m + gap + text.width)) / 2, my = (h - m) / 2;
  const t = wordmark(x + m + gap, (h - h * textFill) / 2 + m * 0.04, h * textFill);
  return svgDoc(w, h, background(w, h) + glow(x, my, m) + mark(x, my, m) + t.svg);
};

const written = [];
const png = (svg, file, width) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng());
  written.push(path.relative(CLIENTS, file));
};
const text = (content, file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push(path.relative(CLIENTS, file));
};

// --- Web admin UI: favicon (the rounded app icon, as SVG) and the iOS home-screen icon.
const tile = squareIcon(64, { radius: 14, fill: 0.84 });
text(tile + "\n", path.join(CLIENTS, "web/public/favicon.svg"));
png(squareIcon(180, { fill: 0.8 }), path.join(CLIENTS, "web/public/apple-touch-icon.png"), 180);

// --- LG webOS (80 and 130), Samsung Tizen (117), Android TV launcher (96, xhdpi).
png(squareIcon(80), path.join(CLIENTS, "tv/devices/lg/package/icon.png"), 80);
png(squareIcon(130), path.join(CLIENTS, "tv/devices/lg/package/largeIcon.png"), 130);
png(squareIcon(117), path.join(CLIENTS, "tv/devices/tizen/package/icon.png"), 117);
png(squareIcon(96), path.join(CLIENTS, "android-tv/app/src/main/res/mipmap-xhdpi/ic_launcher.png"), 96);
// Android TV home-screen banner (320x180 xhdpi): mark and name.
png(banner(320, 180), path.join(CLIENTS, "android-tv/app/src/main/res/drawable/banner.png"), 320);

// --- Android phones and tablets (clients/mobile): an adaptive icon (background and foreground
// layers, 108 dp with the mark inside the 66 dp safe zone, which launchers shape as they like), a
// plain icon for launchers before Android 8, and the launch screen's mark.
const ANDROID_RES = path.join(CLIENTS, "mobile/App_Resources/Android/src/main/res");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = path.join(ANDROID_RES, `mipmap-${name}`);
  const layer = 108 * d, m = 58 * d, o = (layer - m) / 2;
  png(svgDoc(layer, layer, background(layer, layer)), path.join(dir, "ic_launcher_background.png"), layer);
  png(svgDoc(layer, layer, glow(o, o, m) + mark(o, o, m)), path.join(dir, "ic_launcher_foreground.png"), layer);
  png(squareIcon(48 * d, { radius: 10 * d }), path.join(dir, "ic_launcher.png"), 48 * d);
  const logo = 120 * d;
  png(svgDoc(logo, logo, glow(0, 0, logo) + mark(0, 0, logo)), path.join(ANDROID_RES, `drawable-${name}`, "logo.png"), logo);
}

// --- Apple TV: layered app icon (focus parallax) and Top Shelf images, as an asset catalog.
const XCASSETS = path.join(CLIENTS, "appletv/App_Resources/tvOS/Assets.xcassets");
const BRAND = path.join(XCASSETS, "App Icon & Top Shelf Image.brandassets");
const INFO = { version: 1, author: "xcode" };
const json = (dir, value) => text(JSON.stringify({ ...value, info: INFO }, null, 2) + "\n", path.join(dir, "Contents.json"));
const LAYERS = ["Front", "Middle", "Back"];

// On the 400x240 grid: back = background, middle = play triangle (+ glow), front = panda.
// The mark leaves clear margins all round: tvOS scales and shifts layers when focused.
const tvLayer = (layer, scale) => {
  const w = 400 * scale, h = 240 * scale, m = 190 * scale, x = (w - m) / 2 + 6 * scale, y = (h - m) / 2;
  const body = {
    Back: background(w, h),
    Middle: glow(x, y, m) + mark(x, y, m, ["play"]),
    Front: mark(x, y, m, ["panda"]),
  }[layer];
  return { w, svg: svgDoc(w, h, body) };
};
const imagestack = (name, scales) => {
  const dir = path.join(BRAND, `${name}.imagestack`);
  json(dir, { layers: LAYERS.map(l => ({ filename: `${l}.imagestacklayer` })) });
  for (const layer of LAYERS) {
    const layerDir = path.join(dir, `${layer}.imagestacklayer`);
    json(layerDir, {});
    const imageset = path.join(layerDir, "Content.imageset");
    const images = scales.map(({ scale, as }) => {
      const file = `${layer.toLowerCase()}${as === "1x" && scales.length === 1 ? "" : `@${as}`}.png`;
      const { w, svg } = tvLayer(layer, scale);
      png(svg, path.join(imageset, file), w);
      return { idiom: "tv", filename: file, scale: as };
    });
    json(imageset, { images });
  }
};
const topShelf = (name, w1x) => {
  const dir = path.join(BRAND, `${name}.imageset`);
  const images = [1, 2].map(scale => {
    const file = `top-shelf@${scale}x.png`;
    png(banner(w1x * scale, 720 * scale), path.join(dir, file), w1x * scale);
    return { idiom: "tv", filename: file, scale: `${scale}x` };
  });
  json(dir, { images });
};

// Only the icon set is rebuilt: anything else in the catalog (other image sets) is left alone.
fs.rmSync(BRAND, { recursive: true, force: true });
if (!fs.existsSync(path.join(XCASSETS, "Contents.json"))) json(XCASSETS, {});
json(BRAND, {
  assets: [
    { size: "1280x768", idiom: "tv", filename: "App Icon - App Store.imagestack", role: "primary-app-icon" },
    { size: "400x240", idiom: "tv", filename: "App Icon.imagestack", role: "primary-app-icon" },
    { size: "2320x720", idiom: "tv", filename: "Top Shelf Image Wide.imageset", role: "top-shelf-image-wide" },
    { size: "1920x720", idiom: "tv", filename: "Top Shelf Image.imageset", role: "top-shelf-image" },
  ],
});
imagestack("App Icon", [{ scale: 1, as: "1x" }, { scale: 2, as: "2x" }]);
imagestack("App Icon - App Store", [{ scale: 3.2, as: "1x" }]);
topShelf("Top Shelf Image", 1920);
topShelf("Top Shelf Image Wide", 2320);

// --- iPhone and iPad app (clients/mobile): one 1024 px icon (iOS makes the other sizes and rounds
// the corners), square and opaque, in its own asset catalog.
const PHONE = path.join(CLIENTS, "mobile/App_Resources/iOS/Assets.xcassets");
if (!fs.existsSync(path.join(PHONE, "Contents.json"))) json(PHONE, {});
const phoneIcon = path.join(PHONE, "AppIcon.appiconset");
fs.rmSync(phoneIcon, { recursive: true, force: true });
png(squareIcon(1024, { fill: 0.72 }), path.join(phoneIcon, "icon-1024.png"), 1024);
json(phoneIcon, { images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }] });

console.log(written.map(f => `  ${f}`).join("\n"));
