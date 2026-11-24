// What the phone app needs from iOS and Android: one object per OS (platform.ios.ts,
// platform.android.ts), checked against this with `satisfies`, so a missing piece or a wrong
// signature fails the type check. Screens import `platform` from "./platform" and never an OS
// file. The capabilities every Panda app shares (voice, discovery, playback profile, now
// playing, notifications) are the TV client's (@tv/platform/types); the rest are the phone's own.
import type { View, ScrollView } from "@nativescript/core";
import type {
  Discovery,
  NowPlaying,
  Notifications,
  PlaybackProfile,
  Voice,
} from "@tv/platform/types";

export type PlayTarget =
  | { kind: "title"; id: string; version?: number }
  | { kind: "item"; id: number };
export type ClipSource =
  { kind: "title"; id: string } | { kind: "series"; name: string };
export interface ClipHandle {
  stop(): void;
}

export interface SwipeHandlers {
  began: () => void;
  /** The finger's sideways travel so far (points). */
  moved: (tx: number) => void;
  /** Let go: travel and speed (points per second). */
  released: (tx: number, vx: number) => void;
}

/** A one-line question (a name, an email, a PIN). */
export interface PromptOptions {
  title: string;
  message?: string;
  /** What's in the field to start with. */
  text?: string;
  ok: string;
  cancel: string;
  /** `pin`: four digits on the number pad, hidden. */
  kind?: "text" | "email" | "pin";
}

export interface PhonePlatform {
  os: "ios" | "android";
  /** The full-screen player: our own controls, subtitles, audio and quality menus. */
  player: PlaybackProfile & {
    play(
      target: PlayTarget,
      startSecs?: number,
      onClose?: () => void,
    ): Promise<void>;
    /** Development: seek the open player (`-pandaSeek`). */
    devSeek(secs: number): void;
  };
  /** Preview clips over artwork: one at a time, none while the player or another sheet is open. */
  clips: {
    play(
      host: View,
      source: ClipSource,
      onEnded?: () => void,
      onPlaying?: () => void,
      inSheet?: boolean,
    ): ClipHandle;
    stop(): void;
    setPlayerOpen(open: boolean): void;
    setSheetOpen(open: boolean): void;
  };
  voice: Voice;
  discovery: Discovery;
  /** Touch that NativeScript's own gestures don't give. */
  gestures: {
    /** A sideways-only drag on `row` (vertical scrolling keeps working). Returns detach. */
    sideways(row: View, h: SwipeHandlers): () => void;
    /** Snap a horizontal scroller to whole pages. */
    pageSnap(scroller: ScrollView, pageWidth: number): void;
  };
  /** What to call this phone in the account's devices ("Pixel 8"). */
  deviceName(): string;
  /** Ask for a line of text: the answer, or null if cancelled. */
  prompt(o: PromptOptions): Promise<string | null>;
  /** An icon by its SF Symbol name ("house.fill") as an image source. */
  icon(name: string): string;
  nowPlaying?: NowPlaying;
  notifications?: Notifications;
}
