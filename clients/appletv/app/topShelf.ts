// The Top Shelf extension (App_Resources/tvOS/extensions/TopShelf) runs on its own, outside the
// app: it reads the server address and a read-only token (`/api/topshelf/` only, 7 days) from the
// App Group they share. The TV client hands them over through `globalThis.pandaTopShelf` after
// each sign-in, and gets the shelf's links (pandatv://title/m123) through `pandaOpenPath`.
import { Application } from "@nativescript/core";

const GROUP = "group.app.panda.tv";

type OpenPath = (path: string) => void;
const g = globalThis as unknown as {
  pandaTopShelf: { update(server: string, token: string): void; clear(): void };
  /** Set by the TV client once it can navigate; links arriving before that wait. */
  pandaOpenPath?: OpenPath;
  /** A link that arrived before the client was ready (a cold start from the Top Shelf). */
  pandaPendingPath?: string;
};

function shared(): NSUserDefaults | null {
  return NSUserDefaults.alloc().initWithSuiteName(GROUP);
}

function shelfChanged(): void {
  // TVServices isn't in the bundled typings; it's looked up at run time.
  const provider = (globalThis as unknown as {
    TVTopShelfContentProvider?: { topShelfContentDidChange(): void };
  }).TVTopShelfContentProvider;
  try {
    provider?.topShelfContentDidChange();
  } catch {
    // Not available: tvOS refreshes the shelf on its own schedule.
  }
}

/** `pandatv://title/m1` -> `/title/m1` (the client decides what it allows). */
function pathOf(url: NSURL | null | undefined): string | null {
  if (!url || url.scheme !== "pandatv") return null;
  const s = url.absoluteString;
  return s ? "/" + s.slice("pandatv://".length) : null;
}

function open(url: NSURL | null | undefined): void {
  const path = pathOf(url);
  if (!path) return;
  if (g.pandaOpenPath) g.pandaOpenPath(path);
  else g.pandaPendingPath = path;
}

function openContexts(contexts: NSSet<UIOpenURLContext> | null | undefined): void {
  const all = contexts?.allObjects;
  for (let i = 0; i < (all?.count ?? 0); i++) open((all!.objectAtIndex(i) as UIOpenURLContext).URL);
}

export function installTopShelf(): void {
  g.pandaTopShelf = {
    update(server, token) {
      const d = shared();
      if (!d) return;
      d.setObjectForKey(server, "server");
      d.setObjectForKey(token, "shelfToken");
      shelfChanged();
    },
    clear() {
      const d = shared();
      if (!d) return;
      d.removeObjectForKey("shelfToken");
      shelfChanged();
    },
  };
  // Launched from the Top Shelf: the link comes with the scene's connection.
  Application.ios.on("sceneWillConnect", (args: unknown) => {
    const options = (args as { ios?: { connectionOptions?: UISceneConnectionOptions } }).ios?.connectionOptions;
    openContexts(options?.URLContexts);
  });
  // Already running.
  Application.ios.on("sceneOpenURLContexts", (args: unknown) => {
    openContexts((args as { urlContexts?: NSSet<UIOpenURLContext> }).urlContexts);
  });
}
