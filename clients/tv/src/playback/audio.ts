import type { AudioTrack } from "../api/types";
import { languageName } from "../format";
import { t } from "../i18n";

/** "5.1" for 6 channels: how a track's layout is said. */
function layout(channels: number): string | null {
  if (channels === 1) return t("Mono");
  if (channels === 2) return t("Stereo");
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return channels > 0 ? `${channels} ch` : null;
}

/** Codec names as people know them. */
const CODECS: Record<string, string> = {
  aac: "AAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  opus: "Opus",
  mp3: "MP3",
};

/** "English (5.1)": the language and layout; tracks that would read the same get the codec too
 * ("English (5.1, Dolby Digital)"), then a number. */
export function audioLabels(tracks: AudioTrack[]): string[] {
  const name = (a: AudioTrack) => languageName(a.language) ?? t("Unknown language");
  // A commentary track says so ("English (Stereo, Commentary)").
  const notes = (a: AudioTrack, ...more: (string | null)[]) =>
    [...more, /commentary/i.test(a.title ?? "") ? t("Commentary") : null].filter(Boolean).join(", ");
  const base = tracks.map(a => {
    const n = notes(a, layout(a.channels));
    return n ? `${name(a)} (${n})` : name(a);
  });
  const withCodec = tracks.map((a, i) => {
    if (base.filter(b => b === base[i]).length < 2) return base[i];
    return `${name(a)} (${notes(a, layout(a.channels), CODECS[a.codec] ?? a.codec.toUpperCase())})`;
  });
  const seen = new Map<string, number>();
  return withCodec.map(l => {
    const n = withCodec.filter(x => x === l).length;
    if (n < 2) return l;
    const k = (seen.get(l) ?? 0) + 1;
    seen.set(l, k);
    return `${l} ${k}`;
  });
}
