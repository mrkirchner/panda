// Getting this browser signed in, as the TV app does in a browser: a device credential (lists
// and switches the account's profiles) plus a profile session. Served by Panda, a browser that's
// signed in to Panda's web pages pairs itself from that sign-in (no typing); otherwise the
// person signs in with their username and password. Hosted elsewhere, the server's address is
// asked first (Connect).
import { api, AuthError, ensureSession, landingPath, resetSession } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { getDeviceSecret, getToken, setDeviceSecret, setToken, setUnauthorizedHandler } from "@tv/api/session";
import { go } from "./nav";

/** Built to be served by Panda at /watch/ (vite.config.ts). */
export const SERVED_BY_PANDA = !!import.meta.env.VITE_SERVED_BY_PANDA;

/** Pages that work without a profile session. */
export const OPEN_PATHS = ["/connect", "/sign-in", "/profiles"];

/** "Chrome on macOS": how this browser is listed among the account's devices. */
export function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return `Panda web (${os ? `${browser} on ${os}` : browser})`;
}

/** Signed in as a profile (token + device credential): the rest of the app may load. */
export function signedIn(res: { token: string; device_token: string | null }) {
  setToken(res.token);
  if (res.device_token) setDeviceSecret(res.device_token);
  resetSession();
}

/**
 * Start-up: where this browser should be. Returns a path to go to instead of `path`, or null to
 * stay. Never throws.
 */
export async function boot(path: string): Promise<string | null> {
  setUnauthorizedHandler(() => {
    // A revoked profile session goes to Who's watching; a revoked browser signs in again.
    go(getDeviceSecret() ? "/profiles" : "/sign-in", { replace: true });
  });
  if (!getServer()) return path === "/connect" ? null : "/connect";
  if (!getToken()) {
    if (getDeviceSecret()) return OPEN_PATHS.includes(path) ? null : "/profiles";
    if (SERVED_BY_PANDA) {
      try {
        signedIn(await api.deviceFromBrowser(null));
      } catch {
        return OPEN_PATHS.includes(path) ? null : "/sign-in";
      }
    } else {
      return OPEN_PATHS.includes(path) ? null : "/sign-in";
    }
  }
  try {
    await ensureSession();
  } catch (e) {
    if (e instanceof AuthError) return getDeviceSecret() ? "/profiles" : "/sign-in";
    // No answer: the pages say so themselves.
    return null;
  }
  // Launch on Home: pick a profile first when the account has several.
  if (path === "/" && !sessionStorage.getItem("panda.watch.landed")) {
    try {
      sessionStorage.setItem("panda.watch.landed", "1");
    } catch {
      // Asked again next time.
    }
    const landing = await landingPath();
    if (landing !== "/") return landing;
  }
  return null;
}

/** Sign this browser out completely (its device credential too). */
export function signOutBrowser() {
  setToken(null);
  setDeviceSecret(null);
  resetSession();
  go("/sign-in", { replace: true });
}
