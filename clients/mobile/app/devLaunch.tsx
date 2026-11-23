// Debug builds only: open a screen at launch, for checking screens in the simulator without
// tapping (scripts/run-sim.sh passes launch arguments through):
//   -pandaOpen title:<id> | series:<name> | profiles | signin | connect | play-title:<id>
import { goProfiles, goSignIn } from "./session";
import { open } from "./nav";
import { openSeries, openTitle } from "./screens/Home";
import { Connect } from "./screens/Connect";
import { play } from "./player";

export function devLaunch() {
  const args = NSProcessInfo.processInfo.arguments;
  const i = args.indexOfObject("-pandaOpen");
  if (i === NSNotFound || i + 1 >= args.count) return;
  const [what, ...rest] = (args.objectAtIndex(i + 1) as string).split(":");
  const arg = rest.join(":");
  setTimeout(() => {
    if (what === "title") openTitle(arg);
    else if (what === "series") openSeries(arg);
    else if (what === "profiles") goProfiles();
    else if (what === "signin") goSignIn();
    else if (what === "connect") open(() => <Connect />, { clear: true });
    else if (what === "play-title") play({ kind: "title", id: arg }).catch(e => console.log(`play failed: ${String(e)}`));
  }, 300);
}
