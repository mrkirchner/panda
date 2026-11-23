// Hero slides a page at a time on iPhone: the scroll view's own paging.
import type { ScrollView } from "@nativescript/core";

export function pageSnap(scroller: ScrollView, _pageWidth: number): void {
  (scroller.ios as UIScrollView).pagingEnabled = true;
}
