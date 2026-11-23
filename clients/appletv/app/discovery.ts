// Panda servers on the home network, found by Bonjour: the server announces `_panda._tcp`
// (crates/panda-server/src/services/discovery.rs). The TV client asks through
// `globalThis.pandaDiscover()` (its Apple TV device config), gets addresses, and checks each
// before offering it. Needs `_panda._tcp` in Info.plist's NSBonjourServices (and the local
// network usage description, which tvOS shows when it first asks).

/** How long to listen for servers before answering with what was found. */
const BROWSE_MS = 3000;

type Found = (url: string) => void;

// Resolving a found service gives its host name and port.
const ServiceDelegate = (
  NSObject as unknown as {
    extend(
      methods: object,
      info: object,
    ): { new (): NSObject & { found?: Found } };
  }
).extend(
  {
    netServiceDidResolveAddress(
      this: { found?: Found },
      service: NSNetService,
    ) {
      const host = (service.hostName ?? "").replace(/\.$/, "");
      if (host && service.port > 0)
        this.found?.(`http://${host}:${service.port}`);
    },
  },
  { protocols: [NSNetServiceDelegate] },
);

// Each service found is resolved (kept alive meanwhile: resolving is asynchronous).
const BrowserDelegate = (
  NSObject as unknown as {
    extend(
      methods: object,
      info: object,
    ): {
      new (): NSObject & {
        found?: Found;
        services?: NSNetService[];
        delegates?: NSObject[];
      };
    };
  }
).extend(
  {
    netServiceBrowserDidFindServiceMoreComing(
      this: {
        found?: Found;
        services?: NSNetService[];
        delegates?: NSObject[];
      },
      _browser: NSNetServiceBrowser,
      service: NSNetService,
    ) {
      const delegate = new ServiceDelegate();
      delegate.found = this.found;
      service.delegate = delegate as unknown as NSNetServiceDelegate;
      (this.services ??= []).push(service);
      (this.delegates ??= []).push(delegate);
      service.resolveWithTimeout(BROWSE_MS / 1000);
    },
  },
  { protocols: [NSNetServiceBrowserDelegate] },
);

/** The Panda servers Bonjour finds in a few seconds (also the iPhone app's). */
export function findServers(): Promise<string[]> {
  return new Promise((resolve) => {
    const urls = new Set<string>();
    const browser = NSNetServiceBrowser.new();
    const delegate = new BrowserDelegate();
    delegate.found = (url) => urls.add(url);
    browser.delegate = delegate as unknown as NSNetServiceBrowserDelegate;
    browser.searchForServicesOfTypeInDomain("_panda._tcp.", "local.");
    setTimeout(() => {
      browser.stop();
      resolve([...urls]);
    }, BROWSE_MS);
  });
}

/** Install `globalThis.pandaDiscover` for the TV app's Apple TV device config. */
export function installDiscovery(): void {
  (
    globalThis as unknown as { pandaDiscover: () => Promise<string[]> }
  ).pandaDiscover = findServers;
}
