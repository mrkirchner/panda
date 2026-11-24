import { createRenderer, Config as LightningConfig, loadFonts } from "@solidtv/solid";
import { Route } from "@solidjs/router";
import { useFocusManager } from "@solidtv/solid/primitives";
import { HashRouter } from "@solidtv/solid/primitives/router";
import type { RendererMain } from "@solidtv/renderer";
import { lazy } from "solid-js";
import App from "./pages/App";
import Home from "./pages/Home";
import Link from "./pages/Link";
import Connect from "./pages/Connect";
import Series from "./pages/Series";
import NotFound from "./pages/NotFound";
import Title from "./pages/Title";
import Library from "./pages/Library";
import Profiles from "./pages/Profiles";
import EditProfile from "./pages/EditProfile";
import ParentalControls from "./pages/ParentalControls";
import Person from "./pages/Person";
import Genre from "./pages/Genre";
import Browse from "./pages/Browse";
import Preview from "./pages/Preview";
import Search from "./pages/Search";
import fonts from "./fonts";
import { installPointerMode } from "./pointer";
import { merge } from "lodash-es";
import { config } from "#device";
import { perf } from "#devices/tier";
import {
  Rounded,
  RoundedWithShadow,
  RoundedWithBorder,
  RoundedWithBorderAndShadow,
  RadialGradient,
  LinearGradient,
  HolePunch,
} from "@solidtv/renderer/shaders";

merge(LightningConfig, config.lightning);
// Low-tier TVs skip animations (devices/tier.ts).
LightningConfig.animationsEnabled = perf.animations;

// Player (and shaka-player behind it) loads on first playback, keeping startup fast on slow TVs.
const Player = lazy(() => import("./pages/Player"));
// Admins only, rarely opened: kept out of the main bundle.
const Debug = lazy(() => import("./pages/Debug"));
const About = lazy(() => import("./pages/About"));

const { render, renderer } = createRenderer();

// Shaders are WebGL-only; the DOM renderer is never enabled.
const shManager = renderer as RendererMain;
shManager.registerShaderType("rounded", Rounded);
shManager.registerShaderType("roundedWithBorder", RoundedWithBorder);
shManager.registerShaderType("roundedWithShadow", RoundedWithShadow);
shManager.registerShaderType("roundedWithBorderWithShadow", RoundedWithBorderAndShadow);
shManager.registerShaderType("radialGradient", RadialGradient);
shManager.registerShaderType("linearGradient", LinearGradient);
shManager.registerShaderType("holePunch", HolePunch);

loadFonts(fonts);
installPointerMode();
render(() => {
  useFocusManager(config.keys);
  return (
    <HashRouter root={App}>
      <Route path="/" component={Home} />
      <Route path="/link" component={Link} />
      <Route path="/connect" component={Connect} />
      <Route path="/series/:name" component={Series} />
      <Route path="/title/:id" component={Title} />
      <Route path="/movies" component={Browse} />
      <Route path="/shows" component={Browse} />
      <Route path="/movies/all" component={Library} />
      <Route path="/shows/all" component={Library} />
      <Route path="/library/:id" component={Browse} />
      <Route path="/library/:id/all" component={Library} />
      <Route path="/profiles" component={Profiles} />
      <Route path="/profile/edit" component={EditProfile} />
      <Route path="/parental" component={ParentalControls} />
      <Route path="/debug" component={Debug} />
      <Route path="/about" component={About} />
      <Route path="/search" component={Search} />
      <Route path="/discover/:kind/:id" component={Preview} />
      <Route path="/person/:id" component={Person} />
      <Route path="/genre/:name" component={Genre} />
      <Route path="/play/:kind/:id" component={Player} />
      <Route path="/*all" component={NotFound} />
    </HashRouter>
  );
});
