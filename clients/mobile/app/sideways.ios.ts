// The focus row's sideways swipe on iPhone: a pan recognizer that only starts on a mostly
// sideways swipe (so the page still scrolls vertically), reporting the finger's travel.
import type { View } from "@nativescript/core";
import type { SwipeHandlers } from "./platformTypes";


/** Lets the page scroll vertically: the row's pan only starts on a mostly sideways swipe. */
const Sideways = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject };
}).extend(
  {
    gestureRecognizerShouldBegin(g: UIPanGestureRecognizer) {
      const v = g.velocityInView(g.view);
      return Math.abs(v.x) > Math.abs(v.y);
    },
  },
  { protocols: [UIGestureRecognizerDelegate] },
);
const PanTarget = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject & { fn?: (g: UIPanGestureRecognizer) => void } };
}).extend(
  {
    pan(this: { fn?: (g: UIPanGestureRecognizer) => void }, g: UIPanGestureRecognizer) {
      this.fn?.(g);
    },
  },
  { exposedMethods: { pan: { returns: interop.types.void, params: [UIPanGestureRecognizer] } } },
);

/** Attach the swipe to `row`; returns a function that removes it. */
export function attachSideways(row: View, h: SwipeHandlers): () => void {
  const native = row.ios as UIView | undefined;
  if (!native) return () => {};
  // Cards leave at the page margin, not under the screen's edge.
  native.clipsToBounds = true;
  const target = new PanTarget();
  target.fn = (g) => {
    const tx = g.translationInView(g.view).x;
    if (g.state === UIGestureRecognizerState.Began) h.began();
    else if (g.state === UIGestureRecognizerState.Changed) h.moved(tx);
    else if (g.state === UIGestureRecognizerState.Ended || g.state === UIGestureRecognizerState.Cancelled) {
      h.released(tx, g.velocityInView(g.view).x);
    }
  };
  const pan = UIPanGestureRecognizer.alloc().initWithTargetAction(target, "pan");
  const delegate = new Sideways();
  pan.delegate = delegate as unknown as UIGestureRecognizerDelegate;
  native.addGestureRecognizer(pan);
  // The recognizer holds its target and delegate weakly: kept here until detached.
  const keep: NSObject[] = [target, delegate];
  return () => {
    native.removeGestureRecognizer(pan);
    keep.length = 0;
  };
}
