package app.panda.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.work.ListenableWorker;
import androidx.work.WorkerParameters;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;

/**
 * The background "ready to watch" check (app/notifications.android.ts schedules it with
 * WorkManager). In Java because WorkManager creates workers on a background thread, where
 * NativeScript has no JavaScript: this one hops to the main thread and runs the check the app
 * registered with setCheck() (its bundle runs at every start, a background one included).
 */
public class ReadyWorker extends ListenableWorker {
  /** The app's check; calls done.finish() when it's over. */
  public interface Check {
    void run(Done done);
  }

  public interface Done {
    void finish();
  }

  private static volatile Check check;

  public static void setCheck(Check c) {
    check = c;
  }

  public ReadyWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public ListenableFuture<Result> startWork() {
    SettableFuture<Result> future = SettableFuture.create();
    new Handler(Looper.getMainLooper()).post(() -> {
      Check c = check;
      if (c == null) {
        future.set(Result.success());
        return;
      }
      try {
        c.run(() -> future.set(Result.success()));
      } catch (Throwable t) {
        future.set(Result.success());
      }
    });
    return future;
  }
}
