// Casting to a Chromecast from the Android phone: Google's Cast library with its own receiver
// (the Default Media Receiver, CastOptionsProvider.java), so Panda hosts nothing. The player
// (player.android.tsx) shows the Cast button, hands the Chromecast a stream it plays (H.264,
// AAC, signed URLs it can fetch on its own) and then works as the remote.
import { Utils } from "@nativescript/core";

/* eslint-disable @typescript-eslint/no-explicit-any -- the Cast library has no TypeScript declarations here. */
const gms = () => (globalThis as any).com.google.android.gms.cast;

const context = () => Utils.android.getApplicationContext() as android.content.Context;

let shared: any = null;
let failed = false;

/** The Cast context (null without Google Play services: no casting on that phone). */
export function castContext(): any {
  if (shared || failed) return shared;
  try {
    shared = gms().framework.CastContext.getSharedInstance(context());
  } catch (e) {
    failed = true;
    console.log(`casting unavailable: ${String(e)}`);
  }
  return shared;
}

/** The Cast button (shown only while a Chromecast is on the network). */
export function castButton(activity: android.content.Context): android.view.View | null {
  if (!castContext()) return null;
  // The media-route views want a theme of their own (an opaque one), whatever the app's is.
  const themed = new android.view.ContextThemeWrapper(
    activity,
    activity.getResources().getIdentifier("Theme_MediaRouter", "style", activity.getPackageName()) ||
      (androidx as any).mediarouter.R.style.Theme_MediaRouter,
  );
  const button = new (androidx as any).mediarouter.app.MediaRouteButton(themed);
  gms().framework.CastButtonFactory.setUpMediaRouteButton(context(), button);
  return button;
}

export interface CastEvents {
  /** Connected to a Chromecast (its name): hand it the stream. */
  started(device: string): void;
  /** Disconnected (from here, the Chromecast's own controls, or the network). */
  ended(): void;
}

/** Follow Cast sessions; returns the unsubscribe. */
export function followCasting(events: CastEvents): () => void {
  const cc = castContext();
  if (!cc) return () => {};
  const name = (session: any) => String(session?.getCastDevice?.()?.getFriendlyName?.() ?? "TV");
  const listener = new (gms().framework.SessionManagerListener)({
    onSessionStarted: (session: any) => events.started(name(session)),
    onSessionResumed: (session: any) => events.started(name(session)),
    onSessionEnded: () => events.ended(),
    onSessionSuspended: () => {},
    onSessionStarting: () => {},
    onSessionStartFailed: () => {},
    onSessionEnding: () => {},
    onSessionResuming: () => {},
    onSessionResumeFailed: () => {},
  });
  const manager = cc.getSessionManager();
  manager.addSessionManagerListener(listener, gms().framework.CastSession.class);
  return () => manager.removeSessionManagerListener(listener, gms().framework.CastSession.class);
}

/** The Chromecast in use, if casting: its remote media client. */
export function remote(): any {
  const session = castContext()?.getSessionManager().getCurrentCastSession();
  return session?.isConnected() ? session.getRemoteMediaClient() : null;
}

/** The connected Chromecast's name, if one is connected. */
export function castDevice(): string | null {
  const session = castContext()?.getSessionManager().getCurrentCastSession();
  return session?.isConnected() ? String(session.getCastDevice()?.getFriendlyName() ?? "TV") : null;
}

/** What the receiver reports: the stream it has, idle or not, and whether it played to the end. */
export function castState(client: any): { contentId: string | null; idle: boolean; finished: boolean } {
  const MediaStatus = gms().MediaStatus;
  const state = client.getPlayerState();
  const idle = state === MediaStatus.PLAYER_STATE_IDLE || state === MediaStatus.PLAYER_STATE_UNKNOWN;
  return {
    contentId: client.getMediaInfo()?.getContentId() ?? null,
    idle,
    finished: idle && client.getIdleReason() === MediaStatus.IDLE_REASON_FINISHED,
  };
}

/** Stop casting (the Cast session ends; the phone takes over). */
export function stopCasting(): void {
  castContext()?.getSessionManager().endCurrentSession(true);
}

export interface CastMedia {
  url: string;
  hls: boolean;
  title: string;
  subtitle?: string;
  artwork?: string | null;
  /** Where to start in this stream (seconds; an HLS stream starts at 0). */
  startSecs: number;
  /** Text subtitles (WebVTT, signed URLs); `selected` is shown from the start. */
  subtitles: { id: number; url: string; language: string | null; name: string }[];
  selected: number | null;
}

/** Give the Chromecast the stream. */
export function castLoad(client: any, m: CastMedia): void {
  const cast = gms();
  const md = new cast.MediaMetadata(cast.MediaMetadata.MEDIA_TYPE_MOVIE);
  md.putString(cast.MediaMetadata.KEY_TITLE, m.title);
  if (m.subtitle) md.putString(cast.MediaMetadata.KEY_SUBTITLE, m.subtitle);
  if (m.artwork) md.addImage(new (globalThis as any).com.google.android.gms.common.images.WebImage(android.net.Uri.parse(m.artwork)));
  const tracks = new java.util.ArrayList<any>();
  for (const s of m.subtitles) {
    const track = new cast.MediaTrack.Builder(s.id, cast.MediaTrack.TYPE_TEXT)
      .setName(s.name)
      .setSubtype(cast.MediaTrack.SUBTYPE_SUBTITLES)
      .setContentId(s.url)
      .setContentType("text/vtt");
    if (s.language) track.setLanguage(s.language);
    tracks.add(track.build());
  }
  const info = new cast.MediaInfo.Builder(m.url)
    .setStreamType(cast.MediaInfo.STREAM_TYPE_BUFFERED)
    .setContentType(m.hls ? "application/x-mpegURL" : "video/mp4")
    .setMetadata(md)
    .setMediaTracks(tracks);
  // Panda's HLS segments are fragmented MP4 (the receiver assumes MPEG-TS otherwise).
  if (m.hls) info.setHlsSegmentFormat(cast.HlsSegmentFormat.FMP4).setHlsVideoSegmentFormat(cast.HlsVideoSegmentFormat.FMP4);
  const request = new cast.MediaLoadRequestData.Builder()
    .setMediaInfo(info.build())
    .setAutoplay(java.lang.Boolean.valueOf(true))
    .setCurrentTime(Math.round(m.startSecs * 1000));
  if (m.selected !== null) {
    const ids = Array.create("long", 1);
    ids[0] = m.selected;
    request.setActiveTrackIds(ids);
  }
  client.load(request.build());
}

/** Show this text track on the Chromecast (null: none). */
export function castSubtitles(client: any, id: number | null): void {
  const ids = Array.create("long", id === null ? 0 : 1);
  if (id !== null) ids[0] = id;
  client.setActiveMediaTracks(ids);
}

/** Seek the Chromecast's stream to `secs` (stream time). */
export function castSeek(client: any, secs: number): void {
  const options = new (gms().MediaSeekOptions.Builder)().setPosition(Math.round(secs * 1000)).build();
  client.seek(options);
}
