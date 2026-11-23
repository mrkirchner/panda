// Debug builds only: open a screen at launch, for checking screens in the simulator without
// tapping (scripts/run-sim.sh passes launch arguments through):
//   -pandaOpen title:<id> | series:<name> | genre:<name> | all:movies|shows | tab:<0-3> |
//              profiles | signin | connect | play-title:<id>
//   -pandaScroll <points>   then scroll the page down that far
import { goProfiles, goSignIn } from "./session";
import { currentFrame, open } from "./nav";
import { ScrollView, type View } from "@nativescript/core";
import { openAll, openGenre, openSeries, openTitle } from "./screens/links";
import { Connect } from "./screens/Connect";
import { play } from "./player";
import { selectTab } from "./tabs";

const argAfter = (flag: string): string | null => {
  const args = NSProcessInfo.processInfo.arguments;
  const i = args.indexOfObject(flag);
  return i === NSNotFound || i + 1 >= args.count ? null : (args.objectAtIndex(i + 1) as string);
};

/** The first ScrollView in `view`'s tree (vertical ones only). */
function firstScroll(view: View | undefined): ScrollView | null {
  if (!view) return null;
  if (view instanceof ScrollView && view.orientation === "vertical") return view;
  let found: ScrollView | null = null;
  view.eachChildView(child => {
    found ??= firstScroll(child);
    return !found;
  });
  return found;
}

export function devLaunch() {
  const scroll = argAfter("-pandaScroll");
  if (scroll) {
    setTimeout(() => firstScroll(currentFrame()?.currentPage)?.scrollToVerticalOffset(Number(scroll), false), 4000);
  }
  const target = argAfter("-pandaOpen");
  if (!target) return;
  const [what, ...rest] = target.split(":");
  const arg = rest.join(":");
  setTimeout(() => {
    if (what === "title") openTitle(arg);
    else if (what === "series") openSeries(arg);
    else if (what === "genre") openGenre(arg);
    else if (what === "all") openAll(arg === "shows" ? "shows" : "movies");
    else if (what === "tab") selectTab(Number(arg));
    else if (what === "profiles") goProfiles();
    else if (what === "signin") goSignIn();
    else if (what === "connect") open(() => <Connect />, { clear: true });
    else if (what === "play-title") play({ kind: "title", id: arg }).catch(e => console.log(`play failed: ${String(e)}`));
  }, 300);
}
