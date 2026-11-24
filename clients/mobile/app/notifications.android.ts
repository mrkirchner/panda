// Notifications on Android: a "Requests" channel, the permission (Android 13+ asks), and
// `watch`: WorkManager runs the check about every 15 minutes while there's a network, with the
// app closed too (ReadyWorker, in Java, runs the check the app registered at start).
import { Application, Utils } from "@nativescript/core";
import type { Notifications } from "@tv/platform/types";
import { t } from "@tv/i18n";

/* eslint-disable @typescript-eslint/no-explicit-any -- WorkManager has no TypeScript declarations here. */
const work = () => (globalThis as any).androidx.work;

const CHANNEL = "requests";
const PERMISSION = "android.permission.POST_NOTIFICATIONS";
/** The request code of the permission prompt (the voice prompt's is 7311). */
const ASK_CODE = 7312;
/** Unique name of the periodic check (enqueued once; KEEP leaves a scheduled one alone). */
const WORK_NAME = "panda-arrivals";

const context = () => Utils.android.getApplicationContext() as android.content.Context;

function ensureChannel(): void {
  if (android.os.Build.VERSION.SDK_INT < 26) return;
  const manager = context().getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager;
  if (manager.getNotificationChannel(CHANNEL)) return;
  const channel = new android.app.NotificationChannel(
    CHANNEL,
    t("Requests"),
    android.app.NotificationManager.IMPORTANCE_DEFAULT,
  );
  manager.createNotificationChannel(channel);
}

function allowed(): boolean {
  if (android.os.Build.VERSION.SDK_INT < 33) return true;
  return (
    androidx.core.content.ContextCompat.checkSelfPermission(context(), PERMISSION) ===
    android.content.pm.PackageManager.PERMISSION_GRANTED
  );
}

/** The app's own Java package (App_Resources/Android/src/main/java): ReadyWorker. */
declare const app: any;


export const notifications: Notifications = {
  permission() {
    if (allowed()) return Promise.resolve("granted");
    const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as android.app.Activity;
    if (!activity) return Promise.resolve("denied");
    return new Promise((resolve) => {
      const onResult = (e: { requestCode: number }) => {
        if (e.requestCode !== ASK_CODE) return;
        Application.android.off(Application.android.activityRequestPermissionsEvent, onResult);
        resolve(allowed() ? "granted" : "denied");
      };
      Application.android.on(Application.android.activityRequestPermissionsEvent, onResult);
      const perms = Array.create(java.lang.String, 1);
      perms[0] = PERMISSION;
      androidx.core.app.ActivityCompat.requestPermissions(activity, perms, ASK_CODE);
    });
  },

  async show(n) {
    if (!allowed()) return false;
    ensureChannel();
    const ctx = context();
    // Tapping it opens the app on that page (app.tsx reads "panda.open").
    const launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName()) ?? new android.content.Intent();
    if (n.open) launch.putExtra("panda.open", n.open);
    launch.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP);
    const code = Math.abs(hash(n.id));
    const open = android.app.PendingIntent.getActivity(
      ctx,
      code,
      launch,
      android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT,
    );
    const icon = ctx.getResources().getIdentifier("media3_notification_small_icon", "drawable", ctx.getPackageName());
    const built = new androidx.core.app.NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(n.title)
      .setContentText(n.body)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build();
    androidx.core.app.NotificationManagerCompat.from(ctx).notify(n.id, code, built);
    return true;
  },

  watch(fn) {
    // The worker (Java: WorkManager builds it off the main thread) runs this on the main thread.
    app.panda.mobile.ReadyWorker.setCheck(
      new app.panda.mobile.ReadyWorker.Check({
        run: (done: { finish(): void }) => {
          fn().then(
            () => done.finish(),
            () => done.finish(),
          );
        },
      }),
    );
    const w = work();
    const constraints = new w.Constraints.Builder().setRequiredNetworkType(w.NetworkType.CONNECTED).build();
    const request = new w.PeriodicWorkRequest.Builder(app.panda.mobile.ReadyWorker.class, 15, java.util.concurrent.TimeUnit.MINUTES)
      .setConstraints(constraints)
      .build();
    w.WorkManager.getInstance(context()).enqueueUniquePeriodicWork(WORK_NAME, w.ExistingPeriodicWorkPolicy.KEEP, request);
  },
};

/** A stable number for a notification's id (its request code and tag pair). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Debug builds (-pandaOpen check-arrivals): one check `secs` from now through WorkManager, to
 * try the background path (kill the app meanwhile: Android starts it to run the check). */
export function checkSoon(secs: number): void {
  const w = work();
  const request = new w.OneTimeWorkRequest.Builder(app.panda.mobile.ReadyWorker.class)
    .setInitialDelay(secs, java.util.concurrent.TimeUnit.SECONDS)
    .build();
  w.WorkManager.getInstance(context()).enqueue(request);
}
