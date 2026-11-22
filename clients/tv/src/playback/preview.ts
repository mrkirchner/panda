/**
 * Preview clips on the home hero and expanded cards: ~30 s cut from the title by the server
 * (`/api/titles/{id}/clip`), played under the UI. One at a time. The UI keeps its artwork until
 * frames are actually showing (`previewArea()` turns non-null then), so nothing flashes black.
 *
 * Where it shows: "full" (the hero: behind everything, the backdrop fades out) or a rectangle on
 * the 1920x1080 layout grid (an expanded card: the app background gets a hole there, App.tsx).
 * Sound is quiet, or off when the profile says so (Edit profile > Preview sound). Off entirely
 * on low-tier TVs (devices/tier.ts).
 */
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { perf } from "#devices/tier";
import { api } from "../api/client";
import { currentUser } from "../api/session";
import { browserPreviewPlayer } from "./previewPlayer";

export type PreviewSource = { kind: "title"; id: string } | { kind: "series"; name: string };
export type PreviewRect = { x: number; y: number; w: number; h: number; radius: number };
export type PreviewArea = PreviewRect | "full";

/** Plays one clip at a time; Apple TV's host provides its own (AVPlayer). */
export interface PreviewPlayer {
  /** `rect` null = the whole screen. Calls `onPlaying` once frames show, `onEnded` at the end. */
  play(
    url: string,
    rect: PreviewRect | null,
    volume: number,
    onPlaying: () => void,
    onEnded: () => void,
  ): void;
  stop(): void;
}

/** "Quiet": well under the volume a title plays at. */
const QUIET = 0.2;

const player = (): PreviewPlayer =>
  (globalThis as unknown as { pandaNativePreview?: PreviewPlayer }).pandaNativePreview ??
  browserPreviewPlayer;

const [active, setActive] = createSignal<{ owner: symbol; area: PreviewArea } | null>(null);
/** Where a preview is showing right now (null: none, or not playing yet). */
export const previewArea = () => active()?.area ?? null;
/** This owner's preview is showing. */
export const previewing = (owner: symbol) => active()?.owner === owner;

let current: { owner: symbol; cancelled: boolean } | null = null;

export const previewsEnabled = () => perf.previews;

/** Start `source`'s clip for `owner` (replacing any other preview). */
export function startPreview(owner: symbol, source: PreviewSource, area: PreviewArea): void {
  if (!perf.previews) return;
  stopPreview();
  const job = { owner, cancelled: false };
  current = job;
  api
    .clip(source)
    .then(({ url }) => {
      if (job.cancelled || !url) return;
      const volume = currentUser()?.previewSound === false ? 0 : QUIET;
      player().play(
        url,
        area === "full" ? null : area,
        volume,
        () => {
          if (!job.cancelled) setActive({ owner, area });
        },
        () => {
          if (current === job) stopPreview();
        },
      );
    })
    .catch(() => {});
}

/** Stop the preview (only `owner`'s, when given). */
export function stopPreview(owner?: symbol): void {
  if (owner && current?.owner !== owner) return;
  if (current) current.cancelled = true;
  current = null;
  player().stop();
  setActive(null);
}

/** How long a page's backdrop rests before its preview clip starts. */
export const BACKDROP_PREVIEW_DELAY_MS = 2500;

/**
 * A full-screen preview behind a page's backdrop (Home's hero, title and show pages): after
 * `active()` has held for `delayMs` with the same `source()`, the clip fades in; it stops when
 * either changes or the page goes. Returns whether it's showing (fade the backdrop out then).
 */
export function useBackdropPreview(
  source: () => PreviewSource | null | undefined,
  active: () => boolean,
  delayMs = BACKDROP_PREVIEW_DELAY_MS,
): () => boolean {
  const owner = Symbol("backdrop");
  const key = () => {
    const s = source();
    return s ? (s.kind === "title" ? `t:${s.id}` : `s:${s.name}`) : null;
  };
  createEffect(
    on([active, key], ([on, k]) => {
      stopPreview(owner);
      const s = source();
      if (!on || !k || !s || !perf.previews) return;
      const timer = setTimeout(() => startPreview(owner, s, "full"), delayMs);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  onCleanup(() => stopPreview(owner));
  return () => previewing(owner);
}
