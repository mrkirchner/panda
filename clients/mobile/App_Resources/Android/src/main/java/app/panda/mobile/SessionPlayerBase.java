package app.panda.mobile;

import android.net.Uri;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * The player the lock screen and notification show (app/nowPlaying.android.ts extends it):
 * what's playing is handed in with show(), the buttons come back through onPlay() and onSeek().
 * In Java because SimpleBasePlayer's constructors and its State classes are protected, which
 * NativeScript can't reach from TypeScript.
 */
public abstract class SessionPlayerBase extends SimpleBasePlayer {
  /** The skip buttons' step (the player's own). */
  private static final long SKIP_MS = 10_000;

  private boolean shown;
  private String title = "";
  @Nullable private String subtitle;
  @Nullable private String artworkUrl;
  private long durationMs;
  private long positionMs;
  private boolean playing;

  public SessionPlayerBase(Looper looper) {
    super(looper);
  }

  /** Play (true) or pause (false), asked by the system's controls. */
  public abstract void onPlay(boolean play);

  /** Go to this point of the title (file time), asked by the system's controls. */
  public abstract void onSeek(long positionMs);

  /** What's playing and where (durationMs 0: not known yet). */
  public void show(
      String title,
      @Nullable String subtitle,
      @Nullable String artworkUrl,
      long durationMs,
      long positionMs,
      boolean playing) {
    this.shown = true;
    this.title = title;
    this.subtitle = subtitle;
    this.artworkUrl = artworkUrl;
    this.durationMs = durationMs;
    this.positionMs = Math.max(0, positionMs);
    this.playing = playing;
    invalidateState();
  }

  /** Nothing playing. */
  public void clear() {
    shown = false;
    invalidateState();
  }

  @Override
  protected State getState() {
    Player.Commands commands =
        new Player.Commands.Builder()
            .addAll(
                COMMAND_PLAY_PAUSE,
                COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                COMMAND_SEEK_BACK,
                COMMAND_SEEK_FORWARD,
                COMMAND_GET_CURRENT_MEDIA_ITEM,
                COMMAND_GET_METADATA,
                COMMAND_GET_TIMELINE)
            .build();
    State.Builder state =
        new State.Builder()
            .setAvailableCommands(commands)
            .setSeekBackIncrementMs(SKIP_MS)
            .setSeekForwardIncrementMs(SKIP_MS);
    if (!shown) return state.setPlaybackState(STATE_IDLE).build();
    MediaMetadata.Builder md = new MediaMetadata.Builder().setTitle(title).setDisplayTitle(title);
    if (subtitle != null) md.setArtist(subtitle);
    if (artworkUrl != null) md.setArtworkUri(Uri.parse(artworkUrl));
    MediaMetadata metadata = md.build();
    MediaItemData.Builder item =
        new MediaItemData.Builder("panda")
            .setMediaItem(new MediaItem.Builder().setMediaId("panda").setMediaMetadata(metadata).build())
            .setMediaMetadata(metadata)
            .setIsSeekable(true);
    if (durationMs > 0) item.setDurationUs(durationMs * 1000);
    return state
        .setPlaylist(ImmutableList.of(item.build()))
        .setPlaybackState(STATE_READY)
        .setPlayWhenReady(playing, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        .setContentPositionMs(
            playing ? PositionSupplier.getExtrapolating(positionMs, 1f) : PositionSupplier.getConstant(positionMs))
        .build();
  }

  @Override
  protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
    playing = playWhenReady;
    onPlay(playWhenReady);
    return Futures.immediateVoidFuture();
  }

  @Override
  protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, int seekCommand) {
    this.positionMs = Math.max(0, positionMs);
    onSeek(this.positionMs);
    return Futures.immediateVoidFuture();
  }
}
