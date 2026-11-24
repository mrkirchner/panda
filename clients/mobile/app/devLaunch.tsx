// Debug builds only: open a screen at launch, for checking screens in the simulator without
// tapping (scripts/run-sim.sh passes launch arguments through):
//   -pandaOpen title:<id> | series:<name> | genre:<name> | all:movies|shows | tab:<0-3> |
//              profiles | signin | connect | play-title:<id> | play-item:<id>[@<secs>]
//              person:<tmdb id> | preview:movie|series:<tmdb id> | edit-profile |
//              prompt:pin|email|text (the one-line question, platform.prompt) |
//              check-arrivals (Android: a background "ready to watch" check in 20 s)
//   -pandaSearch <query>    Search's starting query (open it with tab:3)
//   -pandaScroll <points>   then scroll the page down that far
//   -pandaSeek <secs>       8 s after launch, seek the open player there
//   -pandaExpand <n>        open card n of Home's first expanding row (as a tap)
//   -pandaRowScroll <n>     swipe that row n cards along
//   -pandaDrag <points>     6 s after launch, drag that row like a finger (negative: leftward)
import { Application } from "@nativescript/core";
import { goProfiles, goSignIn } from "./session";
import { currentFrame, open } from "./nav";
import { ListView, ScrollView, type View } from "@nativescript/core";
import { openAll, openGenre, openPerson, openPreview, openSeries, openTitle } from "./screens/links";
import { Connect } from "./screens/Connect";
import { editProfileScreen } from "./screens/EditProfile";
import { platform } from "./platform";

const { devSeek, play } = platform.player;
import { selectTab } from "./tabs";
import { devDrag, devExpand, devScrollRow } from "./screens/cards";
import { devType, setStartQuery } from "./screens/Search";
import { checkArrivals } from "./arrivals";

/** A launch option: `-pandaOpen title:m1` on iOS (simctl launch arguments), the intent extra
 * `pandaOpen` on Android (`adb shell am start -n app.panda.mobile/com.tns.NativeScriptActivity
 * --es pandaOpen title:m1`). */
const argAfter = (flag: string): string | null => {
  if (__IOS__) {
    const args = NSProcessInfo.processInfo.arguments;
    const i = args.indexOfObject(flag);
    return i === NSNotFound || i + 1 >= args.count ? null : (args.objectAtIndex(i + 1) as string);
  }
  const intent = Application.android?.startActivity?.getIntent();
  return intent?.getStringExtra(flag.replace(/^-/, "")) ?? null;
};

/** The first ScrollView in `view`'s tree (vertical ones only), or a virtual list. */
function firstScroll(view: View | undefined): ScrollView | ListView | null {
  if (!view) return null;
  if (view instanceof ListView) return view;
  if (view instanceof ScrollView && view.orientation === "vertical") return view;
  let found: ScrollView | ListView | null = null;
  view.eachChildView(child => {
    found ??= firstScroll(child);
    return !found;
  });
  return found;
}

/** Before the tabs are built: Search's starting query. */
/** A screen to open was asked for at launch (it goes there, not to Who's watching). */
export const devOpens = () => argAfter("-pandaOpen") !== null;

export function devPrepare() {
  const query = argAfter("-pandaSearch");
  if (query) setStartQuery(query);
}

export function devLaunch() {
  const scroll = argAfter("-pandaScroll");
  if (scroll) {
    setTimeout(() => {
      const target = firstScroll(currentFrame()?.currentPage);
      // A virtual list scrolls by row: the offset over its row height.
      if (target instanceof ListView) {
        const row = typeof target.rowHeight === "number" ? target.rowHeight : 200;
        target.scrollToIndex(Math.floor(Number(scroll) / row));
      }
      else target?.scrollToVerticalOffset(Number(scroll), false);
    }, 4000);
  }
  const typeWord = argAfter("-pandaType");
  if (typeWord) setTimeout(() => devType?.(typeWord), 5000);
  const expand = argAfter("-pandaExpand");
  if (expand) setTimeout(() => devExpand?.(Number(expand)), 4500);
  const dragBy = argAfter("-pandaDrag");
  if (dragBy) setTimeout(() => devDrag?.(Number(dragBy), 450), 6000);
  const rowScroll = argAfter("-pandaRowScroll");
  if (rowScroll) setTimeout(() => devScrollRow?.(Number(rowScroll)), 4500);
  const seek = argAfter("-pandaSeek");
  if (seek) setTimeout(() => devSeek(Number(seek)), 8000);
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
    else if (what === "person") openPerson(Number(arg));
    else if (what === "preview") {
      const [kind, id] = arg.split(":");
      openPreview(kind === "series" ? "series" : "movie", Number(id));
    }
    else if (what === "profiles") goProfiles();
    else if (what === "check-arrivals") {
      if (__ANDROID__) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require("./notifications.android") as { checkSoon(secs: number): void }).checkSoon(20);
      } else if (platform.notifications) {
        // iOS: the simulator runs no background refresh; the same check, now.
        void platform.notifications.permission().then(() => checkArrivals(platform.notifications!));
      }
    }
    else if (what === "prompt") {
      const kind = arg === "pin" || arg === "email" ? arg : "text";
      void platform
        .prompt({ title: "Kids", message: "Enter PIN", ok: "OK", cancel: "Cancel", kind })
        .then(r => console.log(`prompt answered: ${r === null ? "cancelled" : `${r.length} characters`}`));
    }
    else if (what === "edit-profile") open(() => editProfileScreen(), { title: "Edit profile" });
    else if (what === "signin") goSignIn();
    else if (what === "connect") open(() => <Connect />, { clear: true });
    else if (what === "play-title") play({ kind: "title", id: arg }).catch(e => console.log(`play failed: ${String(e)}`));
    else if (what === "play-item") {
      const [id, at] = arg.split("@");
      play({ kind: "item", id: Number(id) }, Number(at ?? 0)).catch(e => console.log(`play failed: ${String(e)}`));
    }
  }, 300);
}
