// The focus row's sideways swipe on Android: NativeScript's pan gesture on the row, which claims
// the touch from the vertical page scroll once the swipe is mostly sideways, reporting the
// finger's travel and (from its last moves) its speed.
import { GestureStateTypes, type EventData, type PanGestureEventData, type View } from "@nativescript/core";

export interface SwipeHandlers {
  began: () => void;
  /** The finger has moved `tx` points sideways from where it started. */
  moved: (tx: number) => void;
  /** Let go after `tx` points, moving at `vx` points/s. */
  released: (tx: number, vx: number) => void;
}

/** Attach the swipe to `row`; returns a function that removes it. */
export function attachSideways(row: View, h: SwipeHandlers): () => void {
  let sideways = false;
  let decided = false;
  /** The last few moves (time, x), for the speed at release. */
  let samples: [number, number][] = [];
  const onPan = (e: PanGestureEventData) => {
    if (e.state === GestureStateTypes.began) {
      decided = false;
      sideways = false;
      samples = [];
      return;
    }
    if (e.state === GestureStateTypes.changed) {
      if (!decided && (Math.abs(e.deltaX) > 8 || Math.abs(e.deltaY) > 8)) {
        decided = true;
        sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (sideways) {
          // The page's vertical scroll lets this swipe have the touch from now on.
          (row.android as android.view.View | undefined)?.getParent()?.requestDisallowInterceptTouchEvent(true);
          h.began();
        }
      }
      if (!sideways) return;
      samples.push([Date.now(), e.deltaX]);
      if (samples.length > 6) samples.shift();
      h.moved(e.deltaX);
      return;
    }
    if (e.state === GestureStateTypes.ended || e.state === GestureStateTypes.cancelled) {
      if (!sideways) return;
      sideways = false;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const vx = first && last && last[0] > first[0] ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000 : 0;
      h.released(e.deltaX, vx);
    }
  };
  const handler = onPan as unknown as (e: EventData) => void;
  row.on("pan", handler);
  return () => row.off("pan", handler);
}
