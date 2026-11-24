// A grid of posters that only builds the rows near the screen (the TV's VirtualGrid): as many
// columns as fit at the poster width for this breakpoint, rows placed with transforms, a few rows
// either side kept ready. Rows are keyed by their number, so a row that stays on screen keeps its
// posters while the window moves (keyed by position, every row would switch titles and repaint).
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";

/** Rows built above and below the screen. */
const BUFFER_ROWS = 3;

export interface GridControls {
  /** Scroll so item `index` is near the top (under the page's sticky bars). */
  scrollToIndex: (index: number) => void;
}

export function VirtualGrid<T>(props: {
  /** Undefined while loading (ghosts hold the place). */
  items: T[] | undefined;
  /** One cell, handed its item as an accessor (cells are reused as the window moves). */
  cell: (item: () => T) => JSX.Element;
  class?: string;
  controls?: (c: GridControls) => void;
}) {
  let grid: HTMLDivElement | undefined;
  const [cols, setCols] = createSignal(3);
  const [rowH, setRowH] = createSignal(240);
  const [range, setRange] = createSignal<[number, number]>([0, 6]);
  const count = () => props.items?.length ?? 0;
  const rowCount = () => Math.ceil(count() / cols());

  const update = () => {
    if (!grid) return;
    const top = grid.getBoundingClientRect().top;
    const h = rowH();
    const first = Math.max(0, Math.floor(-top / h) - BUFFER_ROWS);
    const last = Math.ceil((window.innerHeight - top) / h) + BUFFER_ROWS;
    const [a, b] = range();
    if (a !== first || b !== last) setRange([first, last]);
  };
  /** Columns from the grid's width and this breakpoint's poster width and gap. */
  const measure = () => {
    if (!grid) return;
    const style = getComputedStyle(grid);
    const gap = parseFloat(style.getPropertyValue("--gap")) || 12;
    const minW = parseFloat(style.getPropertyValue("--poster-w")) || 140;
    const width = grid.clientWidth;
    const n = Math.max(2, Math.floor((width + gap) / (minW + gap)));
    const cellW = (width - gap * (n - 1)) / n;
    setCols(n);
    setRowH(Math.round(cellW * 1.5 + gap));
    update();
  };
  onSettled(() => {
    const ro = new ResizeObserver(measure);
    if (grid) ro.observe(grid);
    window.addEventListener("scroll", update, { passive: true });
    props.controls?.({
      scrollToIndex: (i) => {
        if (!grid) return;
        const y = grid.getBoundingClientRect().top + window.scrollY + Math.floor(i / cols()) * rowH();
        window.scrollTo({ top: y - 120, behavior: "smooth" });
      },
    });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update);
    };
  });

  const rows = createMemo(() => {
    const [a, b] = range();
    const out: number[] = [];
    for (let r = a; r < Math.min(b, rowCount()); r++) out.push(r);
    return out;
  });
  const cells = (r: number) => (props.items ?? []).slice(r * cols(), (r + 1) * cols());

  return (
    <div
      class={["vgrid", props.class]}
      ref={(el) => (grid = el)}
      style={{ height: props.items ? `${rowCount() * rowH()}px` : "auto" }}
    >
      <Show
        when={props.items}
        fallback={
          <div
            class="vgrid-row"
            style={{ position: "static", "grid-template-columns": `repeat(${cols()}, 1fr)` }}
          >
            <For each={Array.from({ length: cols() * 3 }, (_, n) => n)}>
              {() => <div class="ghost" style={{ "aspect-ratio": "2 / 3" }} />}
            </For>
          </div>
        }
      >
        <For each={rows()}>
          {(r) => (
            <div
              class="vgrid-row"
              style={{
                transform: `translateY(${r * rowH()}px)`,
                "grid-template-columns": `repeat(${cols()}, 1fr)`,
              }}
            >
              <For each={cells(r)} keyed={false}>
                {(item) => props.cell(item)}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
