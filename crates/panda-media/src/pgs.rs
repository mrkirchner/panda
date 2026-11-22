//! PGS (Blu-ray "Presentation Graphic Stream") subtitles: parse a `.sup` stream into timed
//! bitmap cues, and encode their images as PNG, for the client to draw over the video.
//!
//! A `.sup` file is a sequence of segments (`PG`, PTS, DTS, type, size, data). A display set
//! (composition, windows, palettes, objects, end) shows its objects from its PTS until the next
//! display set replaces or clears it. Objects are run-length encoded 8-bit palette indices; the
//! palette is `YCrCb` + alpha (BT.709).

use std::collections::HashMap;

const PCS: u8 = 0x16;
const PDS: u8 = 0x14;
const ODS: u8 = 0x15;
const END: u8 = 0x80;
/// How long the last cue stays up when nothing clears it.
const LAST_CUE_SECS: f64 = 5.0;

/// One image of a cue, in the subtitle's video coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueImage {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Straight (not premultiplied) RGBA, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    /// The frame size the positions refer to (usually the video's, e.g. 1920x1080).
    pub video_width: u32,
    pub video_height: u32,
    pub images: Vec<CueImage>,
}

#[derive(Default, Clone)]
struct Object {
    width: u32,
    height: u32,
    rle: Vec<u8>,
}

struct Placement {
    object_id: u16,
    x: u32,
    y: u32,
}

/// Parse every complete display set in `data`. A trailing partial set (a file still being
/// written) is ignored, so this can be called again as the file grows.
pub fn parse(data: &[u8]) -> Vec<Cue> {
    let mut cues: Vec<Cue> = Vec::new();
    let mut palettes: HashMap<u8, [[u8; 4]; 256]> = HashMap::new();
    let mut objects: HashMap<u16, Object> = HashMap::new();
    // The display set being read.
    let mut set_pts = 0.0;
    let mut frame = (0u32, 0u32);
    let mut palette_id = 0u8;
    let mut placements: Vec<Placement> = Vec::new();
    let mut open: Option<usize> = None;

    let mut pos = 0;
    while pos + 13 <= data.len() {
        if &data[pos..pos + 2] != b"PG" {
            // Lost sync: skip ahead to the next magic.
            pos += 1;
            continue;
        }
        let pts = f64::from(u32::from_be_bytes([data[pos + 2], data[pos + 3], data[pos + 4], data[pos + 5]]))
            / 90_000.0;
        let kind = data[pos + 10];
        let size = usize::from(u16::from_be_bytes([data[pos + 11], data[pos + 12]]));
        let body_at = pos + 13;
        if body_at + size > data.len() {
            break; // Partial segment at the end of a growing file.
        }
        let body = &data[body_at..body_at + size];
        pos = body_at + size;

        match kind {
            PCS if body.len() >= 11 => {
                set_pts = pts;
                frame = (u32::from(be16(body, 0)), u32::from(be16(body, 2)));
                let state = body[7];
                palette_id = body[9];
                if state & 0x80 != 0 {
                    // Epoch start: earlier objects and palettes no longer apply.
                    objects.clear();
                    palettes.clear();
                }
                placements.clear();
                let count = usize::from(body[10]);
                let mut at = 11;
                for _ in 0..count {
                    if at + 8 > body.len() {
                        break;
                    }
                    let cropped = body[at + 3] & 0x80 != 0;
                    placements.push(Placement {
                        object_id: be16(body, at),
                        x: u32::from(be16(body, at + 4)),
                        y: u32::from(be16(body, at + 6)),
                    });
                    at += if cropped { 16 } else { 8 };
                }
            }
            PDS if body.len() >= 2 => {
                let palette = palettes.entry(body[0]).or_insert([[0; 4]; 256]);
                for e in body[2..].chunks_exact(5) {
                    palette[usize::from(e[0])] = ycrcb_to_rgba(e[1], e[2], e[3], e[4]);
                }
            }
            ODS if body.len() >= 4 => {
                let id = be16(body, 0);
                let sequence = body[3];
                if sequence & 0x80 != 0 {
                    // First fragment: 3-byte length, width, height, then RLE.
                    if body.len() < 11 {
                        continue;
                    }
                    objects.insert(
                        id,
                        Object {
                            width: u32::from(be16(body, 7)),
                            height: u32::from(be16(body, 9)),
                            rle: body[11..].to_vec(),
                        },
                    );
                } else if let Some(o) = objects.get_mut(&id) {
                    o.rle.extend_from_slice(&body[4..]);
                }
            }
            END => {
                // This set replaces whatever was showing.
                if let Some(i) = open.take() {
                    cues[i].end = set_pts.max(cues[i].start);
                }
                let images = render(&placements, &objects, palettes.get(&palette_id));
                if !images.is_empty() {
                    cues.push(Cue {
                        start: set_pts,
                        end: set_pts + LAST_CUE_SECS,
                        video_width: frame.0,
                        video_height: frame.1,
                        images,
                    });
                    open = Some(cues.len() - 1);
                }
            }
            // Windows only bound where objects may draw; placements already say where.
            _ => {}
        }
    }
    cues
}

/// The images of a display set: each placed object, decoded with the set's palette.
fn render(
    placements: &[Placement],
    objects: &HashMap<u16, Object>,
    palette: Option<&[[u8; 4]; 256]>,
) -> Vec<CueImage> {
    let Some(palette) = palette else { return Vec::new() };
    placements
        .iter()
        .filter_map(|p| {
            let o = objects.get(&p.object_id)?;
            let rgba = decode_rle(&o.rle, o.width, o.height, palette)?;
            // Fully transparent objects (used to "erase") draw nothing.
            let visible = rgba.chunks_exact(4).any(|px| px[3] > 0);
            visible.then_some(CueImage { x: p.x, y: p.y, width: o.width, height: o.height, rgba })
        })
        .collect()
}

fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

/// BT.709 limited range `YCrCb` -> RGBA.
fn ycrcb_to_rgba(y: u8, cr: u8, cb: u8, a: u8) -> [u8; 4] {
    let y = 1.164 * (f32::from(y) - 16.0);
    let (cr, cb) = (f32::from(cr) - 128.0, f32::from(cb) - 128.0);
    let clamp = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    [clamp(y + 1.793 * cr), clamp(y - 0.213 * cb - 0.533 * cr), clamp(y + 2.112 * cb), a]
}

/// Decode a PGS run-length encoded object into RGBA. `None` if the data is malformed.
#[allow(clippy::many_single_char_names)] // x/y/w/h/i are the clearest names in pixel code
fn decode_rle(rle: &[u8], width: u32, height: u32, palette: &[[u8; 4]; 256]) -> Option<Vec<u8>> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || w * h > 4096 * 2160 {
        return None;
    }
    let mut out = vec![0u8; w * h * 4];
    let (mut x, mut y) = (0usize, 0usize);
    let mut i = 0;
    let mut put = |x: &mut usize, y: usize, color: u8, run: usize| {
        let px = palette[usize::from(color)];
        for _ in 0..run {
            if *x < w && y < h {
                let o = (y * w + *x) * 4;
                out[o..o + 4].copy_from_slice(&px);
            }
            *x += 1;
        }
    };
    while i < rle.len() && y < h {
        let b = rle[i];
        i += 1;
        if b != 0 {
            put(&mut x, y, b, 1);
            continue;
        }
        let flag = *rle.get(i)?;
        i += 1;
        if flag == 0 {
            // End of line.
            x = 0;
            y += 1;
            continue;
        }
        let long = flag & 0x40 != 0;
        let colored = flag & 0x80 != 0;
        let mut run = usize::from(flag & 0x3F);
        if long {
            run = (run << 8) | usize::from(*rle.get(i)?);
            i += 1;
        }
        let color = if colored {
            let c = *rle.get(i)?;
            i += 1;
            c
        } else {
            0
        };
        put(&mut x, y, color, run);
    }
    Some(out)
}

/// Encode RGBA pixels as a PNG (8-bit RGBA, no filtering, zlib-compressed).
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let row = width as usize * 4;
    let mut raw = Vec::with_capacity((row + 1) * height as usize);
    for line in rgba.chunks_exact(row) {
        raw.push(0); // filter: none
        raw.extend_from_slice(line);
    }
    let idat = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit, RGBA, deflate, no filter, no interlace
    chunk(&mut png, *b"IHDR", &ihdr);
    chunk(&mut png, *b"IDAT", &idat);
    chunk(&mut png, *b"IEND", &[]);
    png
}

fn chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(&kind);
    out.extend_from_slice(data);
    let mut crc = crc32(&kind, 0xFFFF_FFFF);
    crc = crc32(data, crc);
    out.extend_from_slice(&(!crc).to_be_bytes());
}

/// CRC-32 (IEEE), as PNG chunks use. `state` starts at `0xFFFFFFFF`; invert the result.
fn crc32(data: &[u8], mut state: u32) -> u32 {
    for &b in data {
        state ^= u32::from(b);
        for _ in 0..8 {
            state = if state & 1 != 0 { (state >> 1) ^ 0xEDB8_8320 } else { state >> 1 };
        }
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(kind: u8, pts_secs: f64, body: &[u8]) -> Vec<u8> {
        let mut s = b"PG".to_vec();
        s.extend_from_slice(&((pts_secs * 90_000.0) as u32).to_be_bytes());
        s.extend_from_slice(&0u32.to_be_bytes());
        s.push(kind);
        s.extend_from_slice(&u16::try_from(body.len()).unwrap().to_be_bytes());
        s.extend_from_slice(body);
        s
    }

    /// A display set showing one 4x2 object at (100, 900), or clearing the screen.
    fn display_set(pts: f64, show: bool, epoch: bool) -> Vec<u8> {
        let mut pcs = vec![0x07, 0x80, 0x04, 0x38, 0x10, 0x00, 0x01];
        pcs.push(if epoch { 0x80 } else { 0x00 });
        pcs.extend_from_slice(&[0x00, 0x00]); // palette update flag, palette id 0
        if show {
            pcs.extend_from_slice(&[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x03, 0x84]);
        } else {
            pcs.push(0x00);
        }
        let mut out = segment(PCS, pts, &pcs);
        if show {
            // Palette: index 1 = opaque white (Y 235, neutral chroma).
            out.extend(segment(PDS, pts, &[0x00, 0x00, 0x01, 235, 128, 128, 255]));
            // 4x2 object: row 1 = four white pixels, row 2 = 4 transparent (run of color 0).
            let rle = [0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00];
            let mut ods = vec![0x00, 0x00, 0x00, 0xC0];
            let len = rle.len() + 4;
            ods.extend_from_slice(&[0x00, 0x00, u8::try_from(len).unwrap(), 0x00, 0x04, 0x00, 0x02]);
            ods.extend_from_slice(&rle);
            out.extend(segment(ODS, pts, &ods));
        }
        out.extend(segment(END, pts, &[]));
        out
    }

    #[test]
    fn parses_cues_with_timing_position_and_pixels() {
        let mut sup = display_set(10.0, true, true);
        sup.extend(display_set(12.5, false, false));
        let cues = parse(&sup);
        assert_eq!(cues.len(), 1);
        let c = &cues[0];
        assert!((c.start - 10.0).abs() < 1e-6 && (c.end - 12.5).abs() < 1e-6, "{} {}", c.start, c.end);
        assert_eq!((c.video_width, c.video_height), (1920, 1080));
        let img = &c.images[0];
        assert_eq!((img.x, img.y, img.width, img.height), (100, 900, 4, 2));
        assert_eq!(&img.rgba[..4], &[255, 255, 255, 255], "white, opaque");
        assert_eq!(img.rgba[4 * 4 + 3], 0, "second row transparent");
    }

    #[test]
    fn a_growing_file_only_yields_complete_display_sets() {
        let mut sup = display_set(10.0, true, true);
        let whole = sup.len();
        sup.extend(display_set(20.0, true, false));
        // Cut the second set in the middle.
        let cues = parse(&sup[..whole + 20]);
        assert_eq!(cues.len(), 1);
        assert!((cues[0].end - 15.0).abs() < 1e-6, "last cue gets a default length");
    }

    #[test]
    fn png_is_well_formed() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 0, 255, 128]);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        // CRC of an empty IEND chunk is a known constant.
        assert_eq!(&png[png.len() - 4..], &[0xAE, 0x42, 0x60, 0x82]);
    }

    #[test]
    fn malformed_rle_is_rejected_not_a_panic() {
        let palette = [[0u8; 4]; 256];
        assert!(decode_rle(&[0x00], 4, 2, &palette).is_none());
        assert!(decode_rle(&[], 0, 2, &palette).is_none());
    }
}
