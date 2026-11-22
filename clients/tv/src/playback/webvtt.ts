export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIMING = /^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})/;

function seconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Minimal WebVTT parser: timings + plain text (tags stripped). Cues come back sorted by start. */
export function parseWebVtt(input: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = input.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex(l => TIMING.test(l));
    if (i < 0) continue;
    const [, start, end] = lines[i].match(TIMING)!;
    const text = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (text) cues.push({ start: seconds(start), end: seconds(end), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Text of the cue(s) active at `t`. Binary search, so this is cheap to call on every timeupdate. */
export function activeText(cues: Cue[], t: number): string {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  // Walk back over cues that started before t; overlapping cues are joined.
  const out: string[] = [];
  for (let i = lo - 1; i >= 0 && i >= lo - 4; i--) {
    if (cues[i].end > t) out.unshift(cues[i].text);
  }
  return out.join("\n");
}
