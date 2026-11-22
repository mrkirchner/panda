import { createSignal } from "solid-js";

/**
 * Which Panda server this TV talks to. Packaged TV apps (LG, Samsung, Android) don't run from
 * the server's own address, so the person enters it once on the Connect screen; it's kept on
 * the device. Dev builds default to `VITE_PANDA_SERVER`, or this host on :8096.
 */
const KEY = "panda.server";

const stored = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();

const fallback = (): string | null => {
  // Served by the Panda server itself (`/tv`, `pnpm build:server`): it's this very address.
  if (import.meta.env.VITE_SERVED_BY_PANDA && typeof location !== "undefined") return location.origin;
  if (import.meta.env.VITE_PANDA_SERVER) return import.meta.env.VITE_PANDA_SERVER;
  // Served over http(s) (dev, or the server itself): the server is this host.
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return `${location.protocol}//${location.hostname}:8096`;
  }
  return null; // file:// or app:// (packaged): ask.
};

const [server, setServerSignal] = createSignal<string | null>(stored ?? fallback());

export const getServer = server;

export function setServer(value: string) {
  setServerSignal(value);
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Kept for this session only.
  }
}

/** "192.168.1.20" -> "http://192.168.1.20:8096"; trailing slashes removed. */
export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const url = new URL(s);
  if (!url.port && url.protocol === "http:") url.port = "8096";
  return `${url.protocol}//${url.host}`;
}
