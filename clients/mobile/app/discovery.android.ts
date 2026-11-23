// Panda servers on the home network on Android: NSD (Android's Bonjour), as the Android TV app
// does (clients/android-tv MainActivity.Discovery). The server announces `_panda._tcp`
// (crates/panda-server/src/services/discovery.rs); the Connect screen asks through
// through the platform (platform.android.ts) and checks each address before offering it.
import { Application, Utils } from "@nativescript/core";

/** How long to listen for servers before answering with what was found. */
const BROWSE_MS = 3000;

/** The Panda servers NSD finds in a few seconds. */
export function findServers(): Promise<string[]> {
  return new Promise((resolve) => {
    const urls = new Set<string>();
    const ctx = Application.android.context as android.content.Context;
    const nsd = ctx.getSystemService(
      android.content.Context.NSD_SERVICE,
    ) as android.net.nsd.NsdManager;
    // One resolve at a time (older Android refuses overlapping ones): a queue.
    const queue: android.net.nsd.NsdServiceInfo[] = [];
    let resolving = false;
    const next = () => {
      if (resolving) return;
      const info = queue.shift();
      if (!info) return;
      resolving = true;
      nsd.resolveService(
        info,
        new android.net.nsd.NsdManager.ResolveListener({
          onServiceResolved(s: android.net.nsd.NsdServiceInfo) {
            const host = s.getHost()?.getHostAddress();
            if (host && s.getPort() > 0) {
              const shown = host.includes(":") ? `[${host}]` : host;
              Utils.executeOnMainThread(() =>
                urls.add(`http://${shown}:${s.getPort()}`),
              );
            }
            resolving = false;
            next();
          },
          onResolveFailed() {
            resolving = false;
            next();
          },
          onResolutionStopped() {
            resolving = false;
            next();
          },
          onStopResolutionFailed() {},
        }),
      );
    };
    const listener = new android.net.nsd.NsdManager.DiscoveryListener({
      onServiceFound(info: android.net.nsd.NsdServiceInfo) {
        queue.push(info);
        next();
      },
      onServiceLost() {},
      onDiscoveryStarted() {},
      onDiscoveryStopped() {},
      onStartDiscoveryFailed() {},
      onStopDiscoveryFailed() {},
    });
    try {
      nsd.discoverServices(
        "_panda._tcp",
        android.net.nsd.NsdManager.PROTOCOL_DNS_SD,
        listener,
      );
    } catch {
      return resolve([]);
    }
    setTimeout(() => {
      try {
        nsd.stopServiceDiscovery(listener);
      } catch {
        // Already stopped.
      }
      resolve([...urls]);
    }, BROWSE_MS);
  });
}
