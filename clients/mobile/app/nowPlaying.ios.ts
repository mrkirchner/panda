// The lock screen and Control Center on iOS: MPNowPlayingInfoCenter shows what's playing, and
// MPRemoteCommandCenter's buttons (play, pause, skip 10 s, scrubbing) go to the player.
import { ImageSource } from "@nativescript/core";
import type {
  MediaCommands,
  NowPlaying,
  NowPlayingInfo,
  NowPlayingSession,
} from "@tv/platform/types";

/** The skip buttons' step (the player's own). */
const SKIP_SECS = 10;

export const nowPlaying: NowPlaying = {
  start(first: NowPlayingInfo, commands: MediaCommands): NowPlayingSession {
    let info = first;
    let artwork: MPMediaItemArtwork | null = null;
    let artworkUrl: string | null = null;
    let position = 0;
    let playing = false;
    let ended = false;

    const publish = () => {
      if (ended) return;
      const d = NSMutableDictionary.new<string, unknown>();
      d.setObjectForKey(info.title, MPMediaItemPropertyTitle);
      if (info.subtitle)
        d.setObjectForKey(info.subtitle, MPMediaItemPropertyArtist);
      if (info.durationSecs)
        d.setObjectForKey(
          info.durationSecs,
          MPMediaItemPropertyPlaybackDuration,
        );
      d.setObjectForKey(position, MPNowPlayingInfoPropertyElapsedPlaybackTime);
      d.setObjectForKey(playing ? 1 : 0, MPNowPlayingInfoPropertyPlaybackRate);
      d.setObjectForKey(
        MPNowPlayingInfoMediaType.Video,
        MPNowPlayingInfoPropertyMediaType,
      );
      if (artwork) d.setObjectForKey(artwork, MPMediaItemPropertyArtwork);
      MPNowPlayingInfoCenter.defaultCenter().nowPlayingInfo =
        d as unknown as NSDictionary<string, unknown>;
    };

    const loadArtwork = (url: string | null | undefined) => {
      if (!url || url === artworkUrl) return;
      artworkUrl = url;
      ImageSource.fromUrl(url).then(
        (src) => {
          if (ended || url !== artworkUrl) return;
          const image = src.ios as UIImage;
          artwork = MPMediaItemArtwork.alloc().initWithBoundsSizeRequestHandler(
            image.size,
            () => image,
          );
          publish();
        },
        () => {},
      );
    };

    const center = MPRemoteCommandCenter.sharedCommandCenter();
    const targets: { command: MPRemoteCommand; token: unknown }[] = [];
    const on = (
      command: MPRemoteCommand,
      fn: (e: MPRemoteCommandEvent) => void,
    ) => {
      command.enabled = true;
      const token = command.addTargetWithHandler((e) => {
        fn(e);
        publish();
        return MPRemoteCommandHandlerStatus.Success;
      });
      targets.push({ command, token });
    };
    on(center.playCommand, () => commands.play());
    on(center.pauseCommand, () => commands.pause());
    on(center.togglePlayPauseCommand, () =>
      playing ? commands.pause() : commands.play(),
    );
    center.skipForwardCommand.preferredIntervals = NSArray.arrayWithObject(
      SKIP_SECS,
    ) as NSArray<number>;
    center.skipBackwardCommand.preferredIntervals = NSArray.arrayWithObject(
      SKIP_SECS,
    ) as NSArray<number>;
    on(center.skipForwardCommand, () => commands.seekTo(position + SKIP_SECS));
    on(center.skipBackwardCommand, () =>
      commands.seekTo(Math.max(0, position - SKIP_SECS)),
    );
    on(center.changePlaybackPositionCommand, (e) =>
      commands.seekTo((e as MPChangePlaybackPositionCommandEvent).positionTime),
    );

    loadArtwork(info.artworkUrl);
    publish();
    return {
      setInfo(next) {
        info = next;
        loadArtwork(next.artworkUrl);
        publish();
      },
      setPosition(secs, isPlaying) {
        position = secs;
        playing = isPlaying;
        publish();
      },
      end() {
        if (ended) return;
        ended = true;
        for (const { command, token } of targets) command.removeTarget(token);
        MPNowPlayingInfoCenter.defaultCenter().nowPlayingInfo = null;
      },
    };
  },
};
