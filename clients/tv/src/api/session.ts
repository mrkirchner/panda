import { createSignal } from "solid-js";

/**
 * Device session for this TV. The token comes from the device sign-in flow and is kept in
 * localStorage (storage can be unavailable on some TV browsers, hence the try/catch).
 * The token is never shown on screen or logged.
 */
const STORAGE_KEY = "panda.device_token";
/** This TV's own credential (lists/switches profiles). Separate from the profile session. */
const DEVICE_KEY = "panda.device_secret";

const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Kept in memory only when storage is unavailable.
  }
};

let token: string | null = load(STORAGE_KEY);
// A signal so the top bar's profile button works as soon as the TV gets its credential.
const [deviceSecret, setDeviceSecretSignal] = createSignal<string | null>(load(DEVICE_KEY));

export const getDeviceSecret = deviceSecret;
export function setDeviceSecret(value: string | null) {
  setDeviceSecretSignal(value);
  store(DEVICE_KEY, value);
}

export const getToken = () => token;

export function setToken(value: string | null) {
  token = value;
  store(STORAGE_KEY, value);
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
