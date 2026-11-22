import { createSignal } from "solid-js";
import { activeElement, isElementNode, type ElementNode } from "@solidtv/solid";
import { logicalPixelRatio } from "#devices/resolution";

/**
 * Pointer mode: LG's Magic Remote (and a desktop mouse while developing). Hovering focuses,
 * clicking selects, the wheel scrolls. Off by default so a stray mouse never steals focus.
 *
 * - LG: webOS fires `cursorStateChange` when the Magic Remote cursor appears or hides.
 * - Browser: double-click turns it on.
 * - Either: a real arrow key turns it off (as on webOS, where pressing a key hides the cursor).
 *
 * Targets are nodes OK acts on (`onEnter`, not `skipFocus`) plus pointer-only ones that set
 * `onPointerSelect`. Hover focuses a target without
 * touching its Row/Column `selected`, so lists never scroll under the cursor; the selection is
 * synced ("committed") only when a key or the wheel navigates from it.
 */
export const [pointerMode, setPointerMode] = createSignal(false);

/** The target under the cursor (drives the cursor's "on something" look). */
export const [hovered, setHovered] = createSignal<ElementNode | undefined>();

/**
 * Pointer extras on a node: `onPointerSelect` makes it clickable without being focusable by
 * keys; `pointerInsetTop` leaves its top strip out of the hit area (e.g. a section heading
 * drawn inside a menu item); `pointerX`/`pointerWidth` move or widen it horizontally.
 */
type PointerNode = ElementNode & {
  onPointerSelect?: () => void;
  pointerInsetTop?: number;
  /** Hit area drawn offset from / wider than the node (an open or shifted ExpandCard). */
  pointerX?: number;
  pointerWidth?: number;
};
/** The library types these handlers loosely; this is how Row/Column and OK call them. */
type SelectedChanged = (idx: number, el: ElementNode, child: ElementNode, last: number) => void;
type EnterHandler = (this: ElementNode, e: unknown, target: ElementNode, handler: ElementNode) => void;

/** Slightly longer than the Row/Column scroll animation (300ms). */
const SCROLL_SETTLE_MS = 350;

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const ARROW_CODES = new Set([37, 38, 39, 40]);

/** How long the pointer rests on an item before it takes focus. */
const HOVER_FOCUS_MS = 220;
/** Between list steps when a scroll band moves several items (lets a virtual list rebuild). */
const STEP_MS = 70;
/** The pointer-mode scroll band's height. */
export const SCROLL_BAND = 76;
/** Overhang ignored when deciding if something is off screen (focus rings, rounding). */
const EDGE_SLACK = 12;

/**
 * Is there anything to scroll to, above or below what's on screen? Looks for focusable nodes
 * (skipping skipFocus subtrees: closed menus, keyboards) whose middle lies outside the visible
 * area: above or below the screen, or outside a `clipping` window they scroll in. Faded-out
 * nodes count (a header scrolled away comes back with Up); sideways overflow doesn't (that's a
 * row scrolling, not the page). `exclude`: the scroll bands themselves.
 */
export function scrollableDirections(root: ElementNode, exclude: Set<unknown>) {
  const [screenTop, screenBottom] = [0, 1080];
  const out = { up: false, down: false };
  const walk = (node: ElementNode, top: number, bottom: number, left: number, right: number) => {
    if (out.up && out.down) return;
    if (exclude.has(node) || node.skipFocus) return;
    let [t, b, l, r] = [top, bottom, left, right];
    if (node.clipping) {
      const x = node.lng.absX ?? 0;
      const y = node.lng.absY ?? 0;
      t = Math.max(t, y);
      b = Math.min(b, y + (node.height ?? 0));
      l = Math.max(l, x);
      r = Math.min(r, x + (node.width ?? 0));
    }
    if (isTarget(node as PointerNode)) {
      // Not fully in view (partly off an edge, or under the bottom band) counts.
      const cx = (node.lng.absX ?? 0) + (node.width ?? 0) / 2;
      const y = node.lng.absY ?? 0;
      const h = node.height ?? 0;
      if (cx >= l && cx <= r) {
        if (y < t - EDGE_SLACK) out.up = true;
        if (y + h > Math.min(b, screenBottom) + EDGE_SLACK) out.down = true;
      }
    }
    for (const k of node.children) if (isElementNode(k)) walk(k as ElementNode, t, b, l, r);
  };
  walk(root, screenTop, 1080, 0, 1920);
  return out;
}

function isTarget(n: PointerNode) {
  return Boolean(n.onPointerSelect) || (Boolean(n.onEnter) && !n.skipFocus);
}

function contains(n: PointerNode, x: number, y: number) {
  const ax = (n.lng.absX ?? 0) + (n.pointerX ?? 0);
  const ay = (n.lng.absY ?? 0) + (n.pointerInsetTop ?? 0);
  const h = (n.height ?? 0) - (n.pointerInsetTop ?? 0);
  return x >= ax && y >= ay && x <= ax + (n.pointerWidth ?? n.width ?? 0) && y <= ay + h;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

/**
 * Topmost target at (x, y) on the 1920x1080 grid. Children are searched before their parent
 * (a card wins over its row) and in draw order reversed (zIndex, then later siblings), so
 * overlays win over the page. Invisible subtrees (alpha 0) are skipped, and so is anything a
 * `clipping` ancestor hides (rows scrolled out of a grid stay unclickable).
 */
function hitTest(node: ElementNode, x: number, y: number): ElementNode | undefined {
  if (node.alpha === 0) return undefined;
  if (node.clipping) {
    const clip = { x: node.lng.absX ?? 0, y: node.lng.absY ?? 0, w: node.width ?? 0, h: node.height ?? 0 };
    if (!inside(clip, x, y)) return undefined;
  }
  const kids = node.children.filter(isElementNode) as ElementNode[];
  const order = kids
    .map((k, i) => ({ k, i }))
    .sort((a, b) => (b.k.zIndex ?? 0) - (a.k.zIndex ?? 0) || b.i - a.i);
  for (const { k } of order) {
    const hit = hitTest(k, x, y);
    if (hit) return hit;
  }
  return isTarget(node) && contains(node, x, y) ? node : undefined;
}

/**
 * Make each Row/Column on the path to the focused node select it, the same way arrow keys
 * would have. Virtual lists then shift their window from the right item.
 */
function commitHover() {
  let child = activeElement();
  let parent = child?.parent;
  while (child && parent) {
    if (typeof parent.selected === "number") {
      const idx = parent.children.indexOf(child);
      if (idx >= 0 && idx !== parent.selected) {
        const last = parent.selected;
        parent.selected = idx;
        const changed = parent.onSelectedChanged as SelectedChanged | undefined;
        changed?.call(parent, idx, parent, child, last);
      }
    }
    child = parent;
    parent = parent.parent;
  }
}

/**
 * The pointer-mode scroll bands: select the nearest item that's off screen (or partly) in that
 * direction, as if it had been chosen, so its lists scroll it into view. In a plain list that
 * means moving to its section with the list's own Up/Down (e.g. a title's buttons to its tabs);
 * a virtual list (episodes, cards) selects the item itself. Falls back to an arrow press.
 */
export function pageScroll(dir: "up" | "down") {
  if (dir === "up" && stepUpInVirtualList()) return;
  const target = nearestHidden(dir);
  if (!target) {
    if (dir === "down") sendArrow("ArrowDown", 40);
    else sendArrow("ArrowUp", 38);
    return;
  }
  const focused = new Set<unknown>();
  for (let n = activeElement() as ElementNode | undefined; n; n = n.parent as ElementNode | undefined)
    focused.add(n);
  // The target's lists, outermost first, with the child of each that leads to it.
  const chain: { col: ElementNode; branch: ElementNode }[] = [];
  let branch: ElementNode = target;
  for (let col = target.parent as ElementNode | undefined; col; col = col.parent as ElementNode | undefined) {
    if (col.flexDirection === "column" && typeof col.selected === "number") chain.unshift({ col, branch });
    branch = col;
  }
  // Where the move happens: the outermost list whose focused branch isn't the target's and
  // whose branch toward it isn't already fully on screen (a list already in view just needs
  // the move inside it).
  const inView = (n: ElementNode) => {
    // The screen, narrowed by any clipping window around it (scrolled lists).
    let [top, bottom] = [0, 1080];
    for (let p = n.parent as ElementNode | undefined; p; p = p.parent as ElementNode | undefined) {
      if (!p.clipping) continue;
      const py = p.lng.absY ?? 0;
      top = Math.max(top, py);
      bottom = Math.min(bottom, py + (p.height ?? 0));
    }
    const y = n.lng.absY ?? 0;
    return y >= top - EDGE_SLACK && y + (n.height ?? 0) <= bottom + EDGE_SLACK;
  };
  const step = chain.find(({ branch }) => !focused.has(branch) && !inView(branch));
  if (!step) {
    target.setFocus();
    commitHover();
    return;
  }
  const kids = step.col.children.filter(isElementNode) as ElementNode[];
  // A virtual list holds only a window of its items: jump to the item's index (its cursor is
  // the selected child's index in the full list) with the list's own scrollToIndex.
  const v = step.col as unknown as { cursor?: number; scrollToIndex?: (i: number) => void };
  if (typeof v.cursor === "number" && v.scrollToIndex) {
    const index = v.cursor + (kids.indexOf(step.branch) - (step.col.selected ?? 0));
    if (!focused.has(step.col)) {
      v.scrollToIndex.call(step.col, index);
      return;
    }
    // Already in this list: step there with its own Up/Down (scrollToIndex misbehaves on a
    // focused virtual list), each step as a key press would.
    type Step = (this: ElementNode, e: KeyboardEvent, el: ElementNode, active: unknown) => boolean;
    const move = (index > v.cursor ? step.col.onDown : step.col.onUp) as Step | undefined;
    // The list rebuilds its window after each step, so they're spaced out.
    const col = step.col;
    let left = Math.abs(index - v.cursor);
    const tick = () => {
      if (left-- <= 0 || !move) return;
      move.call(col, new KeyboardEvent("keydown"), col, activeElement());
      setTimeout(tick, STEP_MS);
    };
    tick();
    return;
  }
  const from = kids[kids.indexOf(step.branch) + (dir === "down" ? -1 : 1)];
  if (from && !focused.has(from)) {
    from.setFocus();
    commitHover();
  }
  type Nav = (this: ElementNode, e: KeyboardEvent, el: ElementNode, active: unknown) => boolean;
  const nav = (dir === "down" ? step.col.onDown : step.col.onUp) as Nav | undefined;
  if (nav) nav.call(step.col, new KeyboardEvent("keydown"), step.col, activeElement());
  else {
    target.setFocus();
    commitHover();
  }
}

/**
 * Up inside a virtual list (episodes): only items near the selection exist, so the ones above
 * may not be built at all. Select the item just above the first one fully in view, stepping
 * there with the list's own Up. False when focus isn't in such a list or it's at the top.
 */
function stepUpInVirtualList(): boolean {
  for (let n = activeElement() as ElementNode | undefined; n; n = n.parent as ElementNode | undefined) {
    const list = n.parent as (ElementNode & { cursor?: number }) | undefined;
    if (!list || typeof list.cursor !== "number" || list.flexDirection !== "column") continue;
    const kids = list.children.filter(isElementNode) as ElementNode[];
    let top = 0;
    for (let p: ElementNode | undefined = list; p; p = p.parent as ElementNode | undefined) {
      if (p.clipping) top = Math.max(top, p.lng.absY ?? 0);
    }
    const first = kids.findIndex(k => (k.lng.absY ?? 0) >= top - EDGE_SLACK);
    if (first < 0) return false;
    const index = list.cursor + (first - (list.selected ?? 0)) - 1;
    if (index < 0) return false;
    const steps = list.cursor - index;
    if (steps <= 0) return false;
    type Step = (this: ElementNode, e: KeyboardEvent, el: ElementNode, active: unknown) => boolean;
    const up = list.onUp as Step | undefined;
    if (!up) return false;
    let left = steps;
    const tick = () => {
      if (left-- <= 0) return;
      up.call(list, new KeyboardEvent("keydown"), list, activeElement());
      setTimeout(tick, STEP_MS);
    };
    tick();
    return true;
  }
  return false;
}

/** The closest focusable item hidden below (or above) what's on screen. */
function nearestHidden(dir: "up" | "down"): ElementNode | undefined {
  let best: ElementNode | undefined;
  let bestY = dir === "down" ? Infinity : -Infinity;
  const walk = (node: ElementNode, top: number, bottom: number, left: number, right: number) => {
    if (node.skipFocus || (node as PointerNode).onPointerSelect) return;
    let [t, b, l, r] = [top, bottom, left, right];
    if (node.clipping) {
      const x = node.lng.absX ?? 0;
      const y = node.lng.absY ?? 0;
      t = Math.max(t, y);
      b = Math.min(b, y + (node.height ?? 0));
      l = Math.max(l, x);
      r = Math.min(r, x + (node.width ?? 0));
    }
    if (isTarget(node as PointerNode)) {
      const cx = (node.lng.absX ?? 0) + (node.width ?? 0) / 2;
      const y = node.lng.absY ?? 0;
      const h = node.height ?? 0;
      if (cx >= l && cx <= r) {
        if (dir === "down" && y + h > b + EDGE_SLACK && y < bestY) [best, bestY] = [node, y];
        if (dir === "up" && y < t - EDGE_SLACK && y > bestY) [best, bestY] = [node, y];
      }
    }
    for (const k of node.children) if (isElementNode(k)) walk(k as ElementNode, t, b, l, r);
  };
  walk(window.APP, 0, 1080, 0, 1920);
  return best;
}

const key = (k: string, code: number, type = "keydown") =>
  new KeyboardEvent(type, { key: k, keyCode: code, which: code, bubbles: true } as KeyboardEventInit);

/** Act as a remote arrow press (wheel, and the pointer-mode scroll buttons). */
export function sendArrow(k: string, code: number) {
  document.dispatchEvent(key(k, code));
  document.dispatchEvent(key(k, code, "keyup"));
}

/** Where to look for targets: the whole app. */
const searchRoot = () => window.APP;

export function installPointerMode() {
  // The app draws its own cursor (components/PointerCursor), so the system arrow stays hidden.
  document.documentElement.style.cursor = "none";
  const set = (on: boolean) => {
    if (pointerMode() === on) return;
    setPointerMode(on);
    if (!on) setHovered(undefined);
  };

  // webOS: detail.visibility is true while the Magic Remote cursor is on screen.
  document.addEventListener("cursorStateChange", e => {
    set(Boolean((e as CustomEvent<{ visibility?: boolean }>).detail?.visibility));
  });
  // Browser: double-click enables. Ignored once on, so a double-click on a card isn't a toggle.
  window.addEventListener("dblclick", () => set(true));

  let frame = 0;
  let last = { x: -1, y: -1 };
  /** Focus whatever is under the cursor now (after a move, or after the page scrolled). */
  // Focus follows the pointer once it rests on something (HOVER_FOCUS_MS): passing over
  // items on the way somewhere (Home's cards, which open when focused) leaves them alone.
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const updateHover = () => {
    if (!pointerMode() || last.x < 0) return;
    const hit = hitTest(searchRoot(), last.x, last.y) as PointerNode | undefined;
    if (hit === hovered()) return;
    setHovered(hit);
    clearTimeout(focusTimer);
    if (hit && !hit.onPointerSelect && activeElement() !== hit) {
      focusTimer = setTimeout(() => {
        if (hovered() === hit && activeElement() !== hit) hit.setFocus();
      }, HOVER_FOCUS_MS);
    }
  };
  window.addEventListener("mousemove", e => {
    if (!pointerMode()) return;
    last = { x: e.clientX / logicalPixelRatio, y: e.clientY / logicalPixelRatio };
    if (frame) return;
    // One hit test per frame, however fast the remote moves.
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateHover();
    });
  });

  window.addEventListener("click", e => {
    if (!pointerMode()) return;
    const x = e.clientX / logicalPixelRatio;
    const y = e.clientY / logicalPixelRatio;
    const hit = hitTest(searchRoot(), x, y) as PointerNode | undefined;
    if (!hit) return;
    if (hit.onPointerSelect) return hit.onPointerSelect();
    if (activeElement() !== hit) hit.setFocus();
    commitHover();
    (hit.onEnter as EnterHandler | undefined)?.call(hit, e, hit, hit);
  });

  // Wheel: Up/Down (Shift or a sideways swipe: Left/Right), from the hovered item.
  let wheelAt = 0;
  window.addEventListener(
    "wheel",
    e => {
      if (!pointerMode()) return;
      const now = performance.now();
      if (now - wheelAt < 180) return;
      wheelAt = now;
      commitHover();
      const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const d = sideways ? e.deltaX || e.deltaY : e.deltaY;
      if (sideways) sendArrow(d > 0 ? "ArrowRight" : "ArrowLeft", d > 0 ? 39 : 37);
      else sendArrow(d > 0 ? "ArrowDown" : "ArrowUp", d > 0 ? 40 : 38);
      // The page scrolled under a still cursor: refocus what's under it once it settles.
      setTimeout(updateHover, SCROLL_SETTLE_MS);
    },
    { passive: true },
  );

  // A real arrow key leaves pointer mode, navigating from what the cursor was on.
  window.addEventListener(
    "keydown",
    e => {
      if (!pointerMode() || !e.isTrusted || !(ARROWS.has(e.key) || ARROW_CODES.has(e.keyCode))) return;
      commitHover();
      set(false);
    },
    { capture: true },
  );
}

/**
 * Where a row item is drawn, left to right: its own box and its first child's (cards that
 * slide over inside themselves, like Home's expanding row, draw their artwork offset).
 */
function drawnX(k: ElementNode): [number, number] {
  // The card's own width, starting where its content is drawn (an inner node can be wider:
  // an expanded backdrop, a focus ring).
  const inner = k.children.find(isElementNode) as ElementNode | undefined;
  const l = Math.max(k.lng.absX ?? 0, inner?.lng.absX ?? -Infinity);
  return [l, l + (k.width ?? 0)];
}

/** A sideways list (a row of cards) holding focus that has items cut off at either end. */
export interface RowScroll {
  row: ElementNode;
  left: boolean;
  right: boolean;
  y: number;
  height: number;
}

type Nav = (this: ElementNode, e: KeyboardEvent, el: ElementNode, active: unknown) => boolean;

/** The row the focused item is in, horizontal edges of what's visible, and its kids. */
function focusedRow() {
  for (let n = activeElement() as ElementNode | undefined; n; n = n.parent as ElementNode | undefined) {
    const row = n.parent as ElementNode | undefined;
    if (!row || typeof row.selected !== "number" || row.flexDirection === "column" || row.flexWrap === "wrap")
      continue;
    let [left, right] = [0, 1920];
    for (let p: ElementNode | undefined = row; p; p = p.parent as ElementNode | undefined) {
      if (!p.clipping) continue;
      const x = p.lng.absX ?? 0;
      left = Math.max(left, x);
      right = Math.min(right, x + (p.width ?? 0));
    }
    const kids = (row.children.filter(isElementNode) as ElementNode[]).filter(k => !k.skipFocus);
    if (kids.length < 2) continue;
    return { row, kids, left, right };
  }
  return undefined;
}

/** The focused item's index among the row's children. */
function focusedIndex(kids: ElementNode[]) {
  return kids.findIndex(k => {
    for (let n = activeElement() as ElementNode | undefined; n; n = n.parent as ElementNode | undefined) {
      if (n === k) return true;
    }
    return false;
  });
}

/**
 * Whether there's another item past the focused one, cut off or hidden, at either end of its
 * row (for the side scroll bands). The focused item itself doesn't count: on the last card
 * there's nothing more to the right.
 */
export function rowScrollState(): RowScroll | undefined {
  const f = focusedRow();
  if (!f) return undefined;
  const at = focusedIndex(f.kids);
  if (at < 0) return undefined;
  const cursor = (f.row as { cursor?: number }).cursor;
  const firstIndex = typeof cursor === "number" ? cursor - (f.row.selected ?? 0) : 0;
  const leftHidden =
    f.kids.slice(0, at).some(k => drawnX(k)[0] < f.left - EDGE_SLACK) ||
    (firstIndex > 0 && at + firstIndex > 0);
  const rightHidden = f.kids.slice(at + 1).some(k => drawnX(k)[1] > f.right + EDGE_SLACK);
  if (!leftHidden && !rightHidden) return undefined;
  return {
    row: f.row,
    left: leftHidden,
    right: rightHidden,
    y: f.row.lng.absY ?? 0,
    height: f.row.height ?? 0,
  };
}

/**
 * The side bands: move one item that way along the focused row, as the remote's Left/Right
 * would. Rows keep the selection near their start, so each click brings in one more item.
 */
export function rowScroll(dir: "left" | "right") {
  const f = focusedRow();
  if (!f) return;
  const nav = (dir === "right" ? f.row.onRight : f.row.onLeft) as Nav | undefined;
  nav?.call(f.row, new KeyboardEvent("keydown"), f.row, activeElement());
}
