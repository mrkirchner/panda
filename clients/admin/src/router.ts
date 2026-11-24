import { lazy } from "solid-js";
import { createRouter } from "@solidjs/router";
import Login from "./pages/Login";

/** Pages reachable without signing in. Everything else renders the login form when signed out. */
export const PUBLIC_PATHS = ["/setup", "/login", "/invite/", "/sign-in/"];

export const Router = createRouter({
  routes: [
    { path: "/", component: lazy(() => import("./pages/Dashboard")) },
    { path: "/setup", component: lazy(() => import("./pages/Setup")) },
    // Static: the shell also renders Login in place of protected pages.
    { path: "/login", component: Login },
    { path: "/invite/:code", component: lazy(() => import("./pages/Invite")) },
    { path: "/sign-in/:code", component: lazy(() => import("./pages/SignIn")) },
    { path: "/link", component: lazy(() => import("./pages/Link")) },
    { path: "/account", component: lazy(() => import("./pages/Account")) },
    { path: "/libraries", component: lazy(() => import("./pages/Libraries")) },
    { path: "/settings", component: lazy(() => import("./pages/Settings")) },
    { path: "/users", component: lazy(() => import("./pages/Users")) },
    { path: "/devices", component: lazy(() => import("./pages/Devices")) },
    { path: "/matches", component: lazy(() => import("./pages/Matches")) },
    { path: "*404", component: lazy(() => import("./pages/NotFound")) },
  ],
});
