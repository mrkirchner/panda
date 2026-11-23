// What this iPhone or iPad plays, for the server's playback plan (`ClientProfile`): AVPlayer
// plays MP4/MOV directly (HEVC, HDR10, Dolby Vision where the screen does); anything else is
// remuxed to HLS by the server, which is cheap.
import type { ClientProfile } from "@tv/api/types";

export function phoneProfile(): ClientProfile {
  const modes = AVPlayer.availableHDRModes;
  const bounds = UIScreen.mainScreen.nativeBounds.size;
  const long = Math.max(bounds.width, bounds.height);
  return {
    containers: ["mp4", "mov", "m4v"],
    video_codecs: ["h264", "hevc"],
    audio_codecs: ["aac", "mp3", "ac3", "eac3", "alac", "flac"],
    // Phones get 1080p at most (their screens are ~1080 tall); big iPads and AirPlay TVs 4K.
    max_height: long >= 2700 && UIDevice.currentDevice.userInterfaceIdiom === UIUserInterfaceIdiom.Pad ? 2160 : 1080,
    supports_hdr: (modes & AVPlayerHDRMode.HDR10) !== 0,
    supports_dolby_vision: (modes & AVPlayerHDRMode.DolbyVision) !== 0,
    // AVPlayer downmixes surround for the speaker and passes it through over AirPlay.
    max_audio_channels: 8,
  };
}
