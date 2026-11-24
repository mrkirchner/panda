// What a platform provides to Panda's apps, capability by capability. The TV app's devices
// (../../devices: browser, LG, Tizen, Android TV, Apple TV), the phone app (clients/mobile:
// iOS, Android) and the web app (clients/watch) each answer these in their own way; shared code
// and screens only see these shapes. A new platform implements the ones it can: optional ones
// that are missing turn their feature off (the button isn't offered), as the apps already do for
// the server's own features (`/api/features`).
//
// Settings need no implementation: they're kept through `localStorage` (./settings.ts), which a
// platform without one answers in a shim (the phone's is NativeScript's ApplicationSettings).
import type { ClientProfile, Item } from "../api/types";

// ---- Playback ----

/** What this device plays, for the server to choose direct play, remux or a re-encode. */
export interface PlaybackProfile {
  profile(): ClientProfile;
}

// ---- Finding servers ----

/** Panda servers nearby: found by name (Bonjour/NSD), and/or the device's own address, whose
 * network is then scanned for `/api/info` (src/api/discover.ts checks each before offering it). */
export interface Discovery {
  find(): Promise<{ urls: string[]; localIp?: string }>;
}

// ---- Voice search ----

export interface VoiceEvents {
  /** The words so far (they change while you speak). */
  onText: (text: string) => void;
  /** Listening started / stopped. */
  onListening: (on: boolean) => void;
  /** Not allowed or not available, said plainly. */
  onError: (message: string) => void;
}

export interface Voice {
  /** Listen until you stop speaking; the last `onText` is what was said. */
  start(events: VoiceEvents): Promise<void>;
  stop(): void;
  isListening(): boolean;
}

// ---- The system's media controls ----

/** What the lock screen, Control Center, notification shade or media keys show. */
export interface NowPlayingInfo {
  title: string;
  /** An episode's show and number ("Severance  S2:E3"). */
  subtitle?: string;
  artworkUrl?: string | null;
  durationSecs?: number;
}

/** What those controls can ask of the player. */
export interface MediaCommands {
  play(): void;
  pause(): void;
  seekTo(secs: number): void;
}

export interface NowPlayingSession {
  setInfo(info: NowPlayingInfo): void;
  /** Where it's at; called as playback moves (about once a second) and on every change. */
  setPosition(positionSecs: number, playing: boolean): void;
  /** The player closed: the controls go away. */
  end(): void;
}

/** One player at a time holds the system's controls. */
export interface NowPlaying {
  start(info: NowPlayingInfo, commands: MediaCommands): NowPlayingSession;
}

/** The title and subtitle every platform shows for an item. */
export function nowPlayingInfo(
  i: Item | null,
  artworkUrl: string | null,
  durationSecs?: number,
): NowPlayingInfo {
  return {
    title: i ? (i.kind === "episode" ? (i.episode_title ?? i.title) : (i.meta_title ?? i.title)) : "Panda",
    subtitle:
      i?.kind === "episode" ? `${i.series ?? ""}  S${i.season ?? 0}:E${i.episode ?? 0}`.trim() : undefined,
    artworkUrl,
    durationSecs: durationSecs && durationSecs > 0 ? durationSecs : undefined,
  };
}

// ---- Notifications ----

/**
 * Local notifications ("Dune is ready to watch": a request downloaded). None of the apps show
 * any yet; this is the shape a platform fills in when they do. Push (the server telling a
 * sleeping app) needs a server side first (APNs/FCM keys, device registration).
 */
export interface Notifications {
  /** Ask once; answers what the person allowed. */
  permission(): Promise<"granted" | "denied" | "unsupported">;
  /** `open`: the app path to go to when it's tapped ("/title/m927"). Answers whether it was
   * shown (not without permission). */
  show(n: { id: string; title: string; body: string; open?: string }): Promise<boolean>;
  /** Run `check` now and then in the background, as often as the OS allows (Android: about every
   * 15 minutes; iOS: when it decides), app closed included. */
  watch?(check: () => Promise<void>): void;
  /** Where a tapped notification's `open` path goes (platforms that hand it over this way). */
  onOpen?(go: (path: string) => void): void;
}
