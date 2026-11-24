// Notifications in the browser: Web Push (the server sends; public/sw.js shows them), so they
// come with Panda closed too. Subscribed after a first request (asking means something then),
// and kept up at every start once allowed.
import { api } from "@tv/api/client";
import type { Notifications } from "@tv/platform/types";

const supported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** base64url -> bytes (the server's VAPID public key, for `applicationServerKey`). */
function bytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

/** This browser's subscription, sent to the server (made when there's none). */
export async function subscribe(): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await api.pushKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(public_key) });
  }
  await api.pushSubscribe(sub.toJSON());
}

export const notifications: Notifications = {
  async permission() {
    if (!supported()) return "unsupported";
    const answer =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (answer !== "granted") return "denied";
    await subscribe().catch(() => {});
    return "granted";
  },

  async show(n) {
    if (!supported() || Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!reg) return false;
    await reg.showNotification(n.title, { body: n.body, tag: n.id });
    return true;
  },
};
