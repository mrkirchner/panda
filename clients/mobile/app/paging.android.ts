// Hero slides a page at a time on Android (its horizontal scroll view has no paging): when the
// finger lifts, the slide most on screen, or the next one after a flick, scrolls into place.
import type { ScrollView } from "@nativescript/core";

export function pageSnap(scroller: ScrollView, pageWidth: number): void {
  const native = scroller.android as android.widget.HorizontalScrollView | undefined;
  if (!native) return;
  let startX = 0;
  let startAt = 0;
  let startT = 0;
  native.setOnTouchListener(
    new android.view.View.OnTouchListener({
      onTouch(_v: android.view.View, ev: android.view.MotionEvent): boolean {
        const action = ev.getActionMasked();
        if (action === android.view.MotionEvent.ACTION_DOWN) {
          startX = ev.getX();
          startAt = scroller.horizontalOffset;
          startT = Date.now();
        } else if (action === android.view.MotionEvent.ACTION_UP || action === android.view.MotionEvent.ACTION_CANCEL) {
          const density = native.getResources().getDisplayMetrics().density;
          const moved = (startX - ev.getX()) / density;
          const fast = Math.abs(moved) > 40 && Date.now() - startT < 300;
          const from = Math.round(startAt / pageWidth);
          const page = fast ? from + Math.sign(moved) : Math.round(scroller.horizontalOffset / pageWidth);
          const max = Math.max(0, Math.round(scroller.scrollableWidth / pageWidth));
          const to = Math.max(0, Math.min(max, page)) * pageWidth;
          setTimeout(() => scroller.scrollToHorizontalOffset(to, true), 0);
          return true;
        }
        // Let the scroll view follow the finger meanwhile.
        return false;
      },
    }),
  );
}
