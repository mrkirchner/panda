// Panda's web app for watching: the TV app's pages, laid out for phones, tablets and desktops.
import "./styles.css";
import { render, type JSX } from "@solidjs/web";
import { createRouter, useLocation, useNavigate } from "@solidjs/router";
import { Show, createSignal, lazy, onSettled } from "solid-js";
import { Shell } from "./components/Shell";
import { Overlays, closeOverlay } from "./components/ui";
import { appPath, go, markFirstEntry, setNavigator } from "./nav";
import { boot } from "./session";
import Home from "./pages/Home";

const Router = createRouter({
  base: import.meta.env.BASE_URL.replace(/\/$/, ""),
  routes: [
    { path: "/", component: Home },
    {
      path: "/movies",
      component: lazy(() => import("./pages/Browse").then((m) => ({ default: m.MoviesPage }))),
    },
    {
      path: "/shows",
      component: lazy(() => import("./pages/Browse").then((m) => ({ default: m.ShowsPage }))),
    },
    {
      path: "/movies/all",
      component: lazy(() => import("./pages/All").then((m) => ({ default: m.AllMovies }))),
    },
    {
      path: "/shows/all",
      component: lazy(() => import("./pages/All").then((m) => ({ default: m.AllShows }))),
    },
    {
      path: "/library/:id",
      component: lazy(() => import("./pages/Browse").then((m) => ({ default: m.LibraryPage }))),
    },
    {
      path: "/genre/:name",
      component: lazy(() => import("./pages/Browse").then((m) => ({ default: m.GenrePage }))),
    },
    { path: "/title/:id", component: lazy(() => import("./pages/Title")) },
    { path: "/series/:name", component: lazy(() => import("./pages/Series")) },
    { path: "/person/:id", component: lazy(() => import("./pages/Person")) },
    { path: "/discover/:kind/:id", component: lazy(() => import("./pages/Preview")) },
    { path: "/search", component: lazy(() => import("./pages/Search")) },
    { path: "/my-list", component: lazy(() => import("./pages/MyList")) },
    { path: "/profiles", component: lazy(() => import("./pages/Profiles")) },
    { path: "/profile", component: lazy(() => import("./pages/EditProfile")) },
    { path: "/parental", component: lazy(() => import("./pages/ParentalControls")) },
    { path: "/about", component: lazy(() => import("./pages/About")) },
    { path: "/sign-in", component: lazy(() => import("./pages/SignIn")) },
    { path: "/connect", component: lazy(() => import("./pages/Connect")) },
    { path: "/play/:kind/:id", component: lazy(() => import("./player/Player")) },
    { path: "*404", component: lazy(() => import("./pages/NotFound")) },
  ],
});

/** Pages drawn without the top bar and tabs. */
const bare = (path: string) =>
  ["/connect", "/sign-in", "/profiles"].includes(path) || path.startsWith("/play/");

function Root(props: { children?: JSX.Element }) {
  setNavigator(useNavigate());
  const location = useLocation();
  const [ready, setReady] = createSignal(false);
  onSettled(() => {
    const here = appPath(location.pathname);
    void boot(here).then(
      (dest) => {
        // Sent to sign in or pick a profile on the way to a page: back to it afterwards.
        const comeBack = (dest === "/sign-in" || dest === "/profiles") && here !== "/" && !bare(here);
        if (dest)
          go(comeBack ? `${dest}?next=${encodeURIComponent(here + location.search)}` : dest, {
            replace: true,
          });
        setReady(true);
      },
      () => setReady(true),
    );
    markFirstEntry();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOverlay()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <>
      <Show
        when={ready()}
        fallback={
          <div class="center-page">
            <div class="spinner" />
          </div>
        }
      >
        <Show when={!bare(appPath(location.pathname))} fallback={props.children}>
          <Shell>{props.children}</Shell>
        </Show>
      </Show>
      <Overlays />
    </>
  );
}

render(() => <Router>{(props) => <Root>{props.children}</Root>}</Router>, document.getElementById("app")!);
