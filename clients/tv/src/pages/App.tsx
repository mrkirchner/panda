import { markReturn } from "../focusMemory";
import { previewArea, type PreviewRect } from "../playback/preview";
import { trace } from "#devices/debug";
import { ClockCorner } from "../components/ClockCorner";
import { config as deviceConfig } from "#device";
import type { DeviceConfig } from "#devices/devices";
import { createEffect, onMount, Show } from "solid-js";
import { useLocation, useNavigate, type RouteSectionProps } from "@solidjs/router";
import { View, type ElementNode } from "@solidtv/solid";
import { getDeviceSecret, getToken, setDeviceSecret, setToken, setUnauthorizedHandler } from "../api/session";
import { getServer } from "../api/server";
import { api, ensureSession, landingPath } from "../api/client";
import { theme } from "../theme";
import { focusTopBar, notePage, topBarHasFocus } from "../nav";
import { isMainPage } from "../components/TopBar";
import { pointerMode } from "../pointer";
import { PointerCursor } from "../components/PointerCursor";
import { ScrollArrows } from "../components/ScrollArrows";
import { VoiceOverlay } from "../components/VoiceOverlay";
import { startVoiceSearch, stopVoiceSearch, voiceState } from "../voice";

declare global {
  interface Window {
    APP: ElementNode;
  }
}

/** What a Top Shelf link may open: a title or show page, or playing one. */
const SHELF_LINK = /^\/(title\/[^/?#]+|series\/[^/?#]+|play\/(title\/[^/?#]+|item\/\d+))(\?[^#]*)?$/;

export default function App(props: RouteSectionProps) {
  const location = useLocation();
  // The trail of pages (nav.ts): opening one you came through goes back to it.
  createEffect(() => notePage(location.pathname + location.search));
  const navigate = useNavigate();
  // Session missing or revoked. A paired TV just picks a profile again; otherwise pair it.
  const signIn = () => (getDeviceSecret() ? "/profiles" : "/link");
  setUnauthorizedHandler(() => {
    if (location.pathname !== "/profiles") navigate(signIn(), { replace: true });
  });
  createEffect(() => trace(`route ${location.pathname}`));
  onMount(() => {
    trace(
      `start: server ${getServer() ? "set" : "none"}, token ${getToken() ? "yes" : "no"}, device ${getDeviceSecret() ? "yes" : "no"}`,
    );
    // The signed-in profile (top bar avatar, language) and the artwork token, for every page.
    // If it can't be loaded (no answer, an error), don't leave the page loading: back to
    // Who's watching (a revoked session is handled by the unauthorized handler above).
    if (getToken()) {
      void ensureSession().catch((e: unknown) => {
        trace(`session failed: ${String(e)}`);
        if (getToken() && location.pathname !== "/profiles") navigate(signIn(), { replace: true });
      });
    }
    // Packaged apps first need to know where the server is.
    if (!getServer()) return navigate("/connect", { replace: true });
    // Apple TV Top Shelf links (pandatv://title/m1): only to a title, a show or playing one.
    const links = globalThis as unknown as { pandaOpenPath?: (p: string) => void; pandaPendingPath?: string };
    const openLink = (path: string) => {
      if (SHELF_LINK.test(path) && getToken()) navigate(path);
    };
    links.pandaOpenPath = openLink;
    const pending = links.pandaPendingPath;
    links.pandaPendingPath = undefined;
    if (pending && getToken() && SHELF_LINK.test(pending)) return navigate(pending, { replace: true });
    if (!getToken() && !["/link", "/profiles", "/connect"].includes(location.pathname)) {
      // Served by Panda in a browser that's signed in to it: set up from that, no typing.
      if (import.meta.env.VITE_SERVED_BY_PANDA) {
        void api
          .deviceFromBrowser(getDeviceSecret())
          .then(async res => {
            setToken(res.token);
            if (res.device_token) setDeviceSecret(res.device_token);
            navigate(await landingPath(), { replace: true });
          })
          .catch(() => navigate(signIn(), { replace: true }));
        return;
      }
      navigate(signIn(), { replace: true });
    } else if (getToken() && location.pathname === "/") {
      // Launch: pick a profile first when the account has several.
      void landingPath().then(p => p !== "/" && navigate(p, { replace: true }));
    }
  });
  // The video element sits behind the canvas, so the backdrop must disappear during playback.
  const playing = () => location.pathname.startsWith("/play");
  const hole = (): PreviewRect => {
    const a = previewArea();
    return a && a !== "full" ? a : { x: -10, y: -10, w: 0, h: 0, radius: 0 };
  };
  return (
    <View
      ref={window.APP}
      // Back: on a main page (Home, Movies, Shows, Search) it goes to the top bar
      // first, then Home; elsewhere, the previous page. Overlays (menus, keyboards, PIN entry)
      // handle Back first and just close.
      // Voice search from any screen (not during playback): opens Search with what was said.
      onVoice={() => {
        if (playing()) return false;
        startVoiceSearch(text => navigate(`/search?q=${encodeURIComponent(text)}`));
        return true;
      }}
      onBack={() => {
        if (voiceState() !== "idle") return (stopVoiceSearch(), true);
        if (isMainPage(location.pathname)) {
          if (!topBarHasFocus()) return focusTopBar();
          if (location.pathname !== "/") navigate("/", { replace: true });
          // Nothing left to go back to: on Apple TV, Menu returns to the system (unhandled).
          else if ((deviceConfig as unknown as Pick<DeviceConfig, "exitOnRootBack">).exitOnRootBack)
            return false;
          return true;
        }
        markReturn();
        navigate(-1);
        return true;
      }}
    >
      {/* Preview clips play under the canvas (playback/preview.ts): no background over the
          hero's (full screen), a hole in it where a card's plays. Always mounted, so it stays
          under the page (a view added later would draw over it); with no card preview its hole
          is off screen and empty. */}
      <View
        width={theme.screen.width}
        height={theme.screen.height}
        color={theme.color.background}
        alpha={playing() || previewArea() === "full" ? 0 : 1}
        shader={["holePunch", hole()]}
      />
      {props.children}
      <VoiceOverlay />
      {/* Clock (and FPS in dev builds), floating top right; not over the player. */}
      <ClockCorner hidden={playing()} />
      {/* Pointer mode: arrows to reach what's off screen (the cursor only reaches what's on it). */}
      <Show when={pointerMode() && !playing()}>
        <ScrollArrows />
      </Show>
      <Show when={pointerMode()}>
        <PointerCursor />
      </Show>
    </View>
  );
}
