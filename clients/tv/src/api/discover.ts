/**
 * Finding Panda servers on the local network, so the Connect screen can offer them instead of
 * asking for an address. Each device says what it can (`DeviceConfig.discover`): servers it
 * found by name (Bonjour on Apple TV, NSD on Android TV: the server announces `_panda._tcp`),
 * and/or this TV's own address, whose network is then checked for `/api/info` (LG, Samsung:
 * their web apps can't browse for services). Every server is checked before it's offered.
 */
import { config as deviceConfig } from "#device";
import type { DeviceConfig } from "#devices/devices";
import { subnetHosts } from "./subnet";

export interface FoundServer {
  url: string;
  /** The server computer's name ("Living-Room-Mac"). */
  name: string;
  version: string;
}

/** Panda's default port, where scanned addresses are tried. */
const PORT = 8096;
/** How long one address may take to answer before it's skipped. */
const CHECK_MS = 1500;
/** Addresses checked at once while scanning a network. */
const SCAN_AT_ONCE = 40;

/** `url` if a Panda server answers there (its `/api/info`). */
export async function checkServer(url: string, timeoutMs = CHECK_MS): Promise<FoundServer | null> {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/info`, { signal: ctrl?.signal });
    if (!res.ok) return null;
    const info = (await res.json()) as { app?: string; name?: string; version?: string };
    return info.app === "panda" ? { url, name: info.name || url, version: info.version ?? "" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Check every address of `ip`'s network, a few dozen at a time. */
async function scan(ip: string): Promise<FoundServer[]> {
  const hosts = subnetHosts(ip);
  const found: FoundServer[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const s = await checkServer(`http://${host}:${PORT}`);
      if (s) found.push(s);
    }
  };
  await Promise.all(Array.from({ length: SCAN_AT_ONCE }, worker));
  return found;
}

/** Panda servers on this TV's network (checked; each once, by address). */
export async function findServers(): Promise<FoundServer[]> {
  const discover = (deviceConfig as unknown as Pick<DeviceConfig, "discover">).discover;
  type Hints = { urls: string[]; localIp?: string };
  const none: Hints = { urls: [] };
  const hints: Hints = await (discover?.() ?? Promise.resolve(none)).catch(() => none);
  const named = await Promise.all((hints.urls ?? []).map(u => checkServer(u)));
  const scanned = hints.localIp ? await scan(hints.localIp) : [];
  const seen = new Set<string>();
  return [...named, ...scanned].filter((s): s is FoundServer => {
    if (!s || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
