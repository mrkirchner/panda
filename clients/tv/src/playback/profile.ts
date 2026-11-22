import type { ClientProfile } from "../api/types";
import { resolution } from "#devices/resolution";
import { config } from "#device";
import type { DeviceConfig } from "#devices/devices";

/**
 * Report what this device can decode so the server can direct play whenever possible.
 * Every format reported correctly here is a transcode the server never has to run.
 */
export function detectProfile(): ClientProfile {
  // Devices that know their formats without a browser to ask (Apple TV).
  const fromDevice = (config as unknown as Pick<DeviceConfig, "playbackProfile">).playbackProfile;
  if (fromDevice) return fromDevice();
  const video = document.createElement("video");
  const supports = (type: string) =>
    (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported?.(type)) ||
    video.canPlayType(type) === "probably";

  const videoCodecs: [string, string][] = [
    ["h264", 'video/mp4; codecs="avc1.640028"'],
    ["hevc", 'video/mp4; codecs="hvc1.1.6.L120.90"'],
    ["vp9", 'video/webm; codecs="vp9"'],
    ["av1", 'video/mp4; codecs="av01.0.08M.08"'],
  ];
  const audioCodecs: [string, string][] = [
    ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
    ["mp3", "audio/mpeg"],
    ["opus", 'audio/webm; codecs="opus"'],
    ["flac", 'audio/mp4; codecs="flac"'],
    ["ac3", 'audio/mp4; codecs="ac-3"'],
    ["eac3", 'audio/mp4; codecs="ec-3"'],
  ];

  const containers = ["mp4"];
  if (video.canPlayType("video/webm")) containers.push("webm");
  // TV platforms (webOS, Tizen) play Matroska natively even though browsers don't.
  if (video.canPlayType("video/x-matroska") || video.canPlayType("video/mkv")) containers.push("mkv");

  const video_codecs = videoCodecs.filter(([, t]) => supports(t)).map(([c]) => c);
  const hdrDisplay = matchMedia?.("(dynamic-range: high)").matches === true;
  // The panel can be sharper than the UI (a 4K TV running the 1080p UI), so video size comes
  // from the screen, but never less than the UI resolution.
  const panel = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1);
  const panelHeight = panel >= 3840 ? 2160 : panel >= 2560 ? 1440 : panel >= 1900 ? 1080 : 720;

  return {
    containers,
    video_codecs: video_codecs.length ? video_codecs : ["h264"],
    audio_codecs: audioCodecs.filter(([, t]) => supports(t)).map(([c]) => c),
    // A 720p panel gets 720p streams: transcoding down saves bandwidth and the TV's decoder.
    max_height: Math.max(panelHeight, resolution),
    supports_hdr: hdrDisplay && video_codecs.includes("hevc"),
    // Profile 5 (dvh1.05) is the strictest: it has no HDR10 base layer to fall back on.
    supports_dolby_vision: hdrDisplay && supports('video/mp4; codecs="dvh1.05.06"'),
    max_audio_channels: 2,
  };
}
