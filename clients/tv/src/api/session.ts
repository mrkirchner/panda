import { createSignal } from "solid-js";
import { SETTINGS, read, write } from "../platform/settings";

/**
 * Device session for this TV. The token comes from the device sign-in flow and is kept on the
 * device (in memory only when storage is unavailable). The token is never shown on screen or
 * logged. The device's own credential (lists/switches profiles) is separate from the profile
 * session.
 */
let token: string | null = read(SETTINGS.deviceToken);
// A signal so the top bar's profile button works as soon as the TV gets its credential.
const [deviceSecret, setDeviceSecretSignal] = createSignal<string | null>(read(SETTINGS.deviceSecret));

export const getDeviceSecret = deviceSecret;
export function setDeviceSecret(value: string | null) {
  setDeviceSecretSignal(value);
  write(SETTINGS.deviceSecret, value || null);
}

export const getToken = () => token;

export function setToken(value: string | null) {
  token = value;
  write(SETTINGS.deviceToken, value || null);
}

/** The signed-in profile, for the avatar pill. */
export interface CurrentUser {
  id: number;
  username: string;
  /** What to call this profile: its display name, else the username. */
  name: string;
  language: string | null;
  avatar: string | null;
  /** Signs in with this email (its own sign-in); null until set up. */
  email: string | null;
  /** Can sign in with a password (its own, or the owner's). */
  canSignIn: boolean;
  /** The account's owner (its primary profile): it can't be deleted from a TV. */
  primary: boolean;
  /** Home preview clips play (quietly) with sound. */
  previewSound: boolean;
}
export const [currentUser, setCurrentUser] = createSignal<CurrentUser | null>(null);

/** Short-lived signature appended to artwork URLs (image loaders can't send headers). */
export const [imageToken, setImageToken] = createSignal<string | null>(null);

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/** Called by the API client on 401: drop the token and go to the sign-in screen. */
export function signedOut() {
  setToken(null);
  setImageToken(null);
  // Apple TV: the Top Shelf stops showing this profile's rows.
  (globalThis as unknown as { pandaTopShelf?: { clear(): void } }).pandaTopShelf?.clear();
  onUnauthorized();
}
