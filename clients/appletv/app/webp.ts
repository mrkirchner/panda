// WebP artwork on tvOS. The Panda server stores posters and backdrops as WebP, and the canvas
// polyfill's decoder (@nativescript/canvas) has no WebP support there: `createImageBitmap`
// resolves with a 0x0 bitmap, so every image is blank. tvOS's own ImageIO decodes WebP, so a
// WebP blob is decoded by UIImage and handed on re-encoded as JPEG (PNG when it has
// transparency), which the polyfill decodes. Everything else passes straight through.

type CreateImageBitmap = (...args: unknown[]) => Promise<unknown>;

/** "RIFF" .... "WEBP": the first 12 bytes of every WebP file. */
function isWebP(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function hasAlpha(image: UIImage): boolean {
  const info = CGImageGetAlphaInfo(image.CGImage);
  return !(
    info === CGImageAlphaInfo.kCGImageAlphaNone ||
    info === CGImageAlphaInfo.kCGImageAlphaNoneSkipFirst ||
    info === CGImageAlphaInfo.kCGImageAlphaNoneSkipLast
  );
}

/** WebP bytes as JPEG/PNG bytes tvOS encoded, or null if ImageIO can't read them either. */
function transcode(bytes: Uint8Array): { data: ArrayBuffer; type: string } | null {
  const input = NSData.dataWithBytesLength(bytes as unknown as interop.Pointer, bytes.byteLength);
  const image = UIImage.imageWithData(input);
  if (!image?.CGImage) return null;
  const alpha = hasAlpha(image);
  const output = alpha ? UIImagePNGRepresentation(image) : UIImageJPEGRepresentation(image, 0.9);
  if (!output) return null;
  // Copy out of the NSData: the polyfill keeps the bytes past this call.
  const data = new Uint8Array(interop.bufferFromData(output)).slice().buffer;
  return { data, type: alpha ? "image/png" : "image/jpeg" };
}

async function bytesOf(blob: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Wrap the polyfill's `createImageBitmap` (install after the polyfill). */
export function installWebPDecoding(): void {
  const g = globalThis as unknown as { createImageBitmap?: CreateImageBitmap; window?: { createImageBitmap?: CreateImageBitmap } };
  const original = g.createImageBitmap;
  if (!original) return;
  const wrapped: CreateImageBitmap = async (...args) => {
    const source = args[0];
    if (typeof Blob !== "undefined" && source instanceof Blob) {
      const bytes = await bytesOf(source);
      if (bytes && isWebP(bytes)) {
        const converted = transcode(bytes);
        if (converted) return original(new Blob([converted.data], { type: converted.type }), ...args.slice(1));
      }
    }
    return original(...args);
  };
  g.createImageBitmap = wrapped;
  if (g.window) g.window.createImageBitmap = wrapped;
}
