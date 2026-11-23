// A virtual list: iOS's own table (NativeScript's ListView, a UITableView) keeps only the rows on
// screen and reuses them while scrolling, as the TV's VirtualColumn/VirtualGrid do. Each cell
// holds one Solid view that is told its new item when the cell is reused.
import { ListView, type GridLayout, type ItemEventData, type View } from "@nativescript/core";
import { render } from "@nativescript-community/solid-js";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { createSignal, flush, onCleanup } from "solid-js";

type Cell<T> = GridLayout & { show?: (item: T) => void; dispose?: () => void };

/**
 * A ListView showing `items()` with `row` (built once per visible cell, then handed new items).
 * `rowHeight`: every row's height (fixed rows scroll smoothest), or "auto" for rows of different
 * kinds (each is measured). Call `update` with new items.
 */
export function createVirtualList<T>(rowHeight: number | "auto", row: (item: () => T) => JSX.Element) {
  const list = new ListView();
  list.className = "virtual-list";
  list.separatorColor = "transparent" as never;
  // A style property: set after the class (which would otherwise reset it to "auto").
  list.style.setProperty?.("rowHeight", rowHeight);
  list.rowHeight = rowHeight;
  if (rowHeight === "auto") list.iosEstimatedRowHeight = 180;
  let items: T[] = [];
  const cells: Cell<T>[] = [];
  list.on("itemLoading", (args: ItemEventData) => {
    load(args);
  });
  const load = (args: ItemEventData) => {
    const item = items[args.index];
    let cell = args.view as Cell<T> | undefined;
    if (!cell?.show) {
      // A new cell: its view, built once.
      // From the renderer's DOM (a plain `new GridLayout()` can't hold rendered children).
      const host = document.createElement("gridlayout") as unknown as Cell<T>;
      host.dispose = render(() => {
        // Boxed: Solid 2 reads a function given to createSignal as a computation.
        const [current, setCurrent] = createSignal<{ item: T }>({ item });
        host.show = (v: T) => setCurrent({ item: v });
        return row(() => current().item);
      }, host as unknown as Element);
      cells.push(host);
      cell = host;
    } else {
      // A reused cell: the same view, another item (applied now, before it's measured).
      cell.show(item);
      flush();
    }
    args.view = cell as unknown as View;
  };
  // With the screen (not when the list leaves view: it comes back with Back).
  onCleanup(() => {
    for (const c of cells) c.dispose?.();
    cells.length = 0;
  });
  return {
    view: list,
    update(next: T[]) {
      items = next;
      list.items = next;
      list.refresh();
    },
  };
}
