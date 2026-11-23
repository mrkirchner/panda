// What this Android phone or tablet plays, for the server's playback plan (`ClientProfile`): the
// player (Media3 ExoPlayer) reads MP4, Matroska and WebM itself, so most files play directly; the
// codecs are the decoders the phone has (MediaCodecList), so the server converts only what it
// can't decode. HDR when the screen shows it.
import { Application } from "@nativescript/core";
import type { ClientProfile } from "@tv/api/types";

/**
 * Whether the phone has a decoder for `mime` ("video/hevc", "audio/ac3"...). `hardware`: only a
 * hardware one counts (video beyond H.264: decoding HEVC, VP9 or AV1 in software is slow and costs
 * battery, and some software decoders can't draw to a view at all; the server sends H.264 instead).
 */
function decodes(mime: string, hardware = false): boolean {
  const list = new android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS).getCodecInfos();
  for (let i = 0; i < list.length; i++) {
    const info = list[i];
    if (info.isEncoder()) continue;
    if (hardware && !isHardware(info)) continue;
    const types = info.getSupportedTypes();
    for (let j = 0; j < types.length; j++) if (String(types[j]).toLowerCase() === mime) return true;
  }
  return false;
}

/** A hardware decoder (Android 10+ says so; before, software ones are named by convention). */
function isHardware(info: android.media.MediaCodecInfo): boolean {
  if (android.os.Build.VERSION.SDK_INT >= 29) return info.isHardwareAccelerated();
  const name = String(info.getName()).toLowerCase();
  return !name.startsWith("omx.google.") && !name.startsWith("c2.android.") && !name.includes(".sw.");
}

let cached: ClientProfile | null = null;

export function phoneProfile(): ClientProfile {
  if (cached) return cached;
  const video: [string, string][] = [
    ["h264", "video/avc"],
    ["hevc", "video/hevc"],
    ["vp9", "video/x-vnd.on2.vp9"],
    ["av1", "video/av01"],
  ];
  const audio: [string, string][] = [
    ["aac", "audio/mp4a-latm"],
    ["mp3", "audio/mpeg"],
    ["opus", "audio/opus"],
    ["flac", "audio/flac"],
    ["ac3", "audio/ac3"],
    ["eac3", "audio/eac3"],
  ];
  const ctx = Application.android.context as android.content.Context;
  const metrics = ctx.getResources().getDisplayMetrics();
  const long = Math.max(metrics.widthPixels, metrics.heightPixels);
  const short = Math.min(metrics.widthPixels, metrics.heightPixels);
  // HDR types the screen shows (API 24+).
  const display = (ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager).getDefaultDisplay();
  const hdr = display.getHdrCapabilities?.()?.getSupportedHdrTypes() ?? [];
  const hdrTypes = new Set<number>();
  for (let i = 0; i < (hdr.length ?? 0); i++) hdrTypes.add(hdr[i]);
  // H.264 always (every phone decodes it); the rest only with a hardware decoder.
  const videoCodecs = video.filter(([c, m]) => (c === "h264" ? decodes(m) : decodes(m, true))).map(([c]) => c);
  cached = {
    containers: ["mp4", "mov", "m4v", "mkv", "webm"],
    video_codecs: videoCodecs.length ? videoCodecs : ["h264"],
    audio_codecs: audio.filter(([, m]) => decodes(m)).map(([c]) => c),
    // Phones get 1080p at most; tablets with big screens 4K.
    max_height: short >= 1600 && long >= 2560 ? 2160 : 1080,
    supports_hdr: hdrTypes.has(android.view.Display.HdrCapabilities.HDR_TYPE_HDR10) && videoCodecs.includes("hevc"),
    supports_dolby_vision: hdrTypes.has(android.view.Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION),
    // Downmixed for the speaker; surround passes through to a connected receiver.
    max_audio_channels: 8,
  };
  return cached;
}
