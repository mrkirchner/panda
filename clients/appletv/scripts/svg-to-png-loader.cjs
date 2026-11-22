// tvOS build only: the TV client's image paths ending in .svg (in strings and template literals)
// point at the PNGs scripts/rasterize-svgs.cjs made, so the renderer loads them as ordinary
// images. Its SVG path needs an SVG rasterizer, which tvOS doesn't have.
module.exports = function svgToPng(source) {
  return source.replace(/\.svg(?=[`"'?])/g, ".png");
};
