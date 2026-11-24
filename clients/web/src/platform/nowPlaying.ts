// The browser's media controls (keyboard media keys, a phone's lock screen, the notification
// shade): the Media Session API, as the web app's answer to @tv/platform/types' NowPlaying.
import type { MediaCommands, NowPlaying, NowPlayingInfo, NowPlayingSession } from "@tv/platform/types";

/** The skip buttons' step (the player's own). */
const SKIP_SECS = 10;
const ACTIONS = ["play", "pause", "seekbackward", "seekforward", "seekto"] as const;

const none: NowPlayingSession = { setInfo() {}, setPosition() {}, end() {} };

export const nowPlaying: NowPlaying = {
  start(first: NowPlayingInfo, commands: MediaCommands): NowPlayingSession {
    if (!("mediaSession" in navigator)) return none;
    const ms = navigator.mediaSession;
    let position = 0;
    let ended = false;
    const setInfo = (info: NowPlayingInfo) => {
      ms.metadata = new MediaMetadata({
        title: info.title,
        artist: info.subtitle ?? "",
        artwork: info.artworkUrl ? [{ src: info.artworkUrl }] : [],
      });
    };
    const handle = (action: (typeof ACTIONS)[number], fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // Not every browser knows every action.
      }
    };
    handle("play", () => commands.play());
    handle("pause", () => commands.pause());
    handle("seekbackward", () => commands.seekTo(Math.max(0, position - SKIP_SECS)));
    handle("seekforward", () => commands.seekTo(position + SKIP_SECS));
    handle("seekto", (d) => d.seekTime !== undefined && commands.seekTo(d.seekTime));
    setInfo(first);
    return {
      setInfo: (info) => !ended && setInfo(info),
      setPosition(secs, playing) {
        position = secs;
        if (!ended) ms.playbackState = playing ? "playing" : "paused";
      },
      end() {
        if (ended) return;
        ended = true;
        ms.metadata = null;
        for (const a of ACTIONS) handle(a, null);
      },
    };
  },
};
