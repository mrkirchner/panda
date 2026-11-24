// Notifications on iPhone: UNUserNotificationCenter (the permission, showing one, and tapping it
// opening the title), and `watch`: a background app refresh task (BGTaskScheduler) that iOS runs
// when it decides (often every few hours, sooner for apps used a lot); the check also runs when
// the app comes back to the foreground.
import { Application } from "@nativescript/core";
import type { Notifications } from "@tv/platform/types";

/** In Info.plist's BGTaskSchedulerPermittedIdentifiers. */
const TASK = "app.panda.mobile.arrivals";
/** The earliest iOS may run the next check (it usually waits longer). */
const EVERY_SECS = 15 * 60;

/** Where a tapped notification goes (`onOpen`, from app.tsx; the path is in the notification). */
let onOpen: ((path: string) => void) | null = null;

// Shown while the app is open too (as a banner), and a tap opens its page.
@NativeClass()
class Delegate extends NSObject implements UNUserNotificationCenterDelegate {
  static ObjCProtocols = [UNUserNotificationCenterDelegate];
  userNotificationCenterWillPresentNotificationWithCompletionHandler(
    _center: UNUserNotificationCenter,
    _notification: UNNotification,
    done: (options: UNNotificationPresentationOptions) => void,
  ): void {
    done(UNNotificationPresentationOptions.Banner | UNNotificationPresentationOptions.List);
  }
  userNotificationCenterDidReceiveNotificationResponseWithCompletionHandler(
    _center: UNUserNotificationCenter,
    response: UNNotificationResponse,
    done: () => void,
  ): void {
    const path = response.notification.request.content.userInfo.objectForKey("open") as string | null;
    if (path) onOpen?.(String(path));
    done();
  }
}
const delegate = Delegate.new();
UNUserNotificationCenter.currentNotificationCenter().delegate = delegate as Delegate;

const status = (): Promise<UNAuthorizationStatus> =>
  new Promise((resolve) =>
    UNUserNotificationCenter.currentNotificationCenter().getNotificationSettingsWithCompletionHandler((s) =>
      resolve(s.authorizationStatus),
    ),
  );

let check: (() => Promise<void>) | null = null;

function schedule(): void {
  const request = BGAppRefreshTaskRequest.alloc().initWithIdentifier(TASK);
  request.earliestBeginDate = new Date(Date.now() + EVERY_SECS * 1000);
  try {
    BGTaskScheduler.sharedScheduler.submitTaskRequestError(request);
  } catch {
    // Background refresh off (Settings) or the simulator: the foreground check still runs.
  }
}

export const notifications: Notifications = {
  async permission() {
    const now = await status();
    if (now === UNAuthorizationStatus.Authorized || now === UNAuthorizationStatus.Provisional) return "granted";
    if (now === UNAuthorizationStatus.Denied) return "denied";
    return new Promise((resolve) =>
      UNUserNotificationCenter.currentNotificationCenter().requestAuthorizationWithOptionsCompletionHandler(
        UNAuthorizationOptions.Alert | UNAuthorizationOptions.Sound,
        (ok) => resolve(ok ? "granted" : "denied"),
      ),
    );
  },

  async show(n) {
    const now = await status();
    if (now !== UNAuthorizationStatus.Authorized && now !== UNAuthorizationStatus.Provisional) return false;
    const content = UNMutableNotificationContent.new();
    content.title = n.title;
    content.body = n.body;
    content.sound = UNNotificationSound.defaultSound;
    if (n.open) content.userInfo = NSDictionary.dictionaryWithObjectForKey(n.open, "open");
    const request = UNNotificationRequest.requestWithIdentifierContentTrigger(n.id, content, null);
    return new Promise((resolve) =>
      UNUserNotificationCenter.currentNotificationCenter().addNotificationRequestWithCompletionHandler(request, (err) =>
        resolve(!err),
      ),
    );
  },

  watch(fn) {
    check = fn;
    // Registered before launch finishes (app.tsx runs this at the top), as iOS requires.
    BGTaskScheduler.sharedScheduler.registerForTaskWithIdentifierUsingQueueLaunchHandler(TASK, null, (task: BGTask) => {
      schedule();
      let over = false;
      task.expirationHandler = () => {
        over = true;
        task.setTaskCompletedWithSuccess(false);
      };
      const finish = () => !over && task.setTaskCompletedWithSuccess(true);
      (check ?? (() => Promise.resolve()))().then(finish, finish);
    });
    schedule();
    // Coming back to the app checks too (what arrived while away shows at once).
    Application.on(Application.resumeEvent, () => void check?.());
  },

  onOpen(go) {
    onOpen = go;
  },
};
