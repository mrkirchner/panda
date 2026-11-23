// The system's media controls on Android (lock screen, notification shade, headphone and
// Bluetooth buttons, Android Auto), as the platform's answer to @tv/platform/types' NowPlaying.
//
// Media3's MediaSession shows a player; ours is a SimpleBasePlayer whose state we hand it (title,
// artwork, where it's at on the file's own timeline, playing or not), so its buttons come back
// as the player's own commands: a seek goes through the player's planSeek (restarting the stream
// when it has to), never straight into ExoPlayer's stream-relative clock. PlaybackService (a
// MediaSessionService, declared in AndroidManifest.xml) hosts the session: it posts the media
// notification and keeps the app running while something plays in the background.
import { Utils } from "@nativescript/core";
import type { MediaCommands, NowPlaying, NowPlayingInfo, NowPlayingSession } from "@tv/platform/types";

/** The app's own Java package (App_Resources/Android/src/main/java), a global like `android`. */
declare const app: any;

/* eslint-disable @typescript-eslint/no-explicit-any -- Media3 has no TypeScript declarations here. */
const media3 = () => (globalThis as any).androidx.media3;

/** The commands of the player being shown (null: nothing playing). One player at a time. */
let commands: MediaCommands | null = null;
let session: any = null;
let service: any = null;

// The player the session shows (SessionPlayerBase, App_Resources/Android/src/main/java: it keeps
// the state handed to `show`); its buttons go to the real player.
const SessionPlayer = app.panda.mobile.SessionPlayerBase.extend("app.panda.mobile.SessionPlayer", {
  onPlay(play: boolean): void {
    if (play) commands?.play();
    else commands?.pause();
  },
  onSeek(positionMs: number): void {
    commands?.seekTo(positionMs / 1000);
  },
});

// Hosts the session while the player is open (started by `start`, stopped by `end`).
const PlaybackService = (androidx as any).media3.session.MediaSessionService.extend(
  "app.panda.mobile.PlaybackService",
  {
    onCreate(): void {
      this.super.onCreate();
      service = this;
      if (session) this.addSession(session);
    },
    onGetSession(_controller: any): any {
      return session;
    },
    // Swiped away from recent apps: nothing keeps playing.
    onTaskRemoved(_intent: android.content.Intent): void {
      commands?.pause();
      this.stopSelf();
    },
    onDestroy(): void {
      if (service === this) service = null;
      this.super.onDestroy();
    },
  },
);

export const nowPlaying: NowPlaying = {
  start(first: NowPlayingInfo, mineCommands: MediaCommands): NowPlayingSession {
    const ctx = Utils.android.getApplicationContext() as android.content.Context;
    commands = mineCommands;
    let info = first;
    let positionMs = 0;
    let playing = false;
    let ended = false;
    const player = new SessionPlayer(android.os.Looper.getMainLooper());
    const show = () => {
      if (ended) return;
      player.show(
        info.title,
        info.subtitle ?? null,
        info.artworkUrl ?? null,
        Math.round((info.durationSecs ?? 0) * 1000),
        Math.round(positionMs),
        playing,
      );
    };
    show();
    // Tapping the notification opens the app (where the player is).
    const launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
    const open = android.app.PendingIntent.getActivity(
      ctx,
      0,
      launch ?? new android.content.Intent(),
      android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT,
    );
    const mySession = new (media3().session.MediaSession.Builder)(ctx, player)
      .setId("panda")
      .setSessionActivity(open)
      .build();
    session = mySession;
    const intent = new android.content.Intent(ctx, PlaybackService.class);
    try {
      ctx.startService(intent);
    } catch (e) {
      // Not allowed right now (the app already in the background): controls without the service.
      console.log(`media service didn't start: ${String(e)}`);
    }
    return {
      setInfo(next) {
        info = next;
        show();
      },
      setPosition(secs, isPlaying) {
        positionMs = secs * 1000;
        playing = isPlaying;
        show();
      },
      end() {
        if (ended) return;
        ended = true;
        if (commands === mineCommands) commands = null;
        player.clear();
        if (session === mySession) session = null;
        service?.removeSession(mySession);
        mySession.release();
        ctx.stopService(intent);
      },
    };
  },
};
