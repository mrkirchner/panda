import { useTopBarShown } from "./ClockCorner";
import { createEffect, createMemo, on, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { api } from "../api/client";
import { currentUser, getDeviceSecret } from "../api/session";
import { registerTopBar } from "../nav";
import { displayText } from "../format";
import { theme } from "../theme";
import { t } from "../i18n";
import { Avatar } from "./Avatar";
import { FocusRing } from "./FocusRing";
import { Label } from "./Label";

const { screen, color, font, focus } = theme;
const H = 52;
/** Room for a focused item's ring (offset + width, ~14 px with the grow) plus a clear gap. */
const GAP = theme.space.item;
const Y = 34;
/** Tab width for a label (the fonts have no measuring API; this fits the caption size). */
const widthFor = (label: string) => 56 + label.length * 15;

/** The pages the bar switches between (tabs replace each other in history). */
export const MAIN_PAGES = ["/", "/movies", "/shows", "/search"];
/** A main page: one of those, or a library's tab (`/library/{id}`). */
export const isMainPage = (path: string) => MAIN_PAGES.includes(path) || /^\/library\/[^/]+$/.test(path);
/** Tabs shown at once; more scroll in a window of this many (each then the same width). */
const MAX_TABS = 5;
const TAB_W = 210;

function Tab(props: {
  label: string;
  active: boolean;
  width: number;
  /** Outside the bar's window of tabs: not drawn. */
  hidden?: boolean;
  onFocused?: () => void;
  onSelect: () => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width;
  return (
    <View
      width={w()}
      height={H}
      borderRadius={theme.radius.sm}
      color={focused() ? color.focusFill : props.active ? color.accent : 0x00000000}
      alpha={props.hidden ? 0 : 1}
      transition={{ color: { duration: focus.duration }, alpha: { duration: focus.duration } }}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) props.onFocused?.();
      }}
      onEnter={() => (props.onSelect(), true)}
    >
      <Label
        text={props.label}
        width={w()}
        height={H}
        size={font.caption}
        color={focused() ? color.focusText : props.active ? color.accentText : color.textMuted}
      />
      <FocusRing width={w()} height={H} radius={theme.radius.sm} visible={focused()} />
    </View>
  );
}

/** A round item at the left of the bar: the profile avatar, or the search icon. */
function RoundItem(props: { onSelect: () => void; children: (focused: boolean) => unknown }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={H}
      height={H}
      borderRadius={H / 2}
      scale={focused() ? 1.1 : 1}
      transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      {props.children(focused()) as never}
      <FocusRing width={H} height={H} radius={H / 2} ringWidth={theme.focus.ringWidth} visible={focused()} />
    </View>
  );
}

/**
 * The app's navigation, at the top of every main page (like the Apple TV app): the profile
 * (opens "Who's watching?"), Search, then Home, Movies and Shows, and the clock.
 * Up from a page's top reaches it, Down returns; Back from anywhere on a main page lands here.
 */
export function TopBar(props: {
  onDown: () => boolean;
  visible?: boolean;
  /** Home/Movies/Shows tabs: on every page (from a title or person page, a way straight out). */
  tabs?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const onSearch = () => location.pathname === "/search";
  const [libraries] = createResource(() => api.libraries().catch(() => []));
  const withTabs = () => props.tabs !== false;
  const tabs = createMemo(() =>
    !withTabs()
      ? []
      : [
          { label: t("Home"), path: "/" },
          // A tab per library, by its name (the admin's order).
          ...(libraries() ?? []).map(l => ({ label: displayText(l.name), path: `/library/${l.id}` })),
        ],
  );
  /** Tabs replace each other in history; from another page (a title, a person...) they're opened
   * on top of it. On a main page, Back never walks back through what came before. */
  const go = (path: string) => {
    if (location.pathname === path) return;
    navigate(path, { replace: isMainPage(location.pathname) });
  };
  // The clock floats app-wide (ClockCorner); it sits in this bar's row while it's up.
  useTopBarShown(() => props.visible !== false);
  // A library whose NAS is offline: said under the clock until it's back (checked each minute).
  const [offline, setOffline] = createSignal<string[]>([]);
  const checkOffline = () => void api.offlineLibraries().then(setOffline, () => {});
  checkOffline();
  const offlineTimer = setInterval(checkOffline, 60_000);
  onCleanup(() => clearInterval(offlineTimer));

  // Avatar and search on the left; tabs centered on the screen (a spacer between them).
  const leftW = H * 2 + GAP;
  /** More than MAX_TABS: all one width, in a window of MAX_TABS that scrolls. */
  const many = () => tabs().length > MAX_TABS;
  const tabW = (label: string) => (many() ? TAB_W : widthFor(label));
  const tabsW = () =>
    many()
      ? TAB_W * MAX_TABS + GAP * (MAX_TABS - 1)
      : tabs().length
        ? tabs().reduce((w, i) => w + widthFor(i.label), 0) + GAP * (tabs().length - 1)
        : 0;
  /** The current page's tab (a library's grid counts as its tab); none on other pages. */
  /** The first tab in the window (more than MAX_TABS): moves to keep the focused one in it. */
  const [first, setFirst] = createSignal(0);
  const keepInWindow = (i: number) => {
    if (i >= first() + MAX_TABS) setFirst(i - MAX_TABS + 1);
    else if (i < first()) setFirst(i);
  };
  // The current page's tab in view (only when the page changes, not as focus moves the window).
  createEffect(
    on(
      () => currentTab(),
      i => keepInWindow(Math.max(0, i)),
    ),
  );
  const currentTab = () =>
    tabs().findIndex(
      tab =>
        tab.path === location.pathname || (tab.path !== "/" && location.pathname.startsWith(`${tab.path}/`)),
    );
  const spacer = () => Math.max(GAP, (screen.width - tabsW()) / 2 - screen.gutter - leftW - GAP * 2);
  /** Focus lands on the current page's tab (indexes: avatar, search, spacer, tabs...). */
  const activeIndex = () => {
    if (!withTabs()) return 1;
    if (location.pathname === "/search") return 1;
    // The tabs (one window, index 3); on a page that's none of them, Home: the way out.
    return 3;
  };
  const switchable = () => Boolean(getDeviceSecret());

  return (
    <View width={screen.width} height={Y + H + 20} alpha={props.visible === false ? 0 : 1} zIndex={10}>
      <Row
        ref={(el: ElementNode) => registerTopBar(el)}
        x={screen.gutter}
        y={Y}
        width={leftW + GAP + spacer() + GAP + tabsW()}
        height={H}
        gap={GAP}
        scroll="none"
        selected={activeIndex()}
        onDown={props.onDown}
        onUp={() => true}
      >
        <RoundItem onSelect={() => switchable() && navigate("/profiles?from=menu")}>
          {() => <Avatar name={currentUser()?.name || "?"} size={H} picture={currentUser()?.avatar} />}
        </RoundItem>
        <RoundItem onSelect={() => go("/search")}>
          {focused => (
            <View
              width={H}
              height={H}
              borderRadius={H / 2}
              // On the Search page: gold, like the current page's tab.
              color={focused ? color.focusFill : onSearch() ? color.accent : theme.glass.regular}
            >
              <View
                src="images/icons/search.svg"
                x={(H - 26) / 2}
                y={(H - 26) / 2}
                width={26}
                height={26}
                color={focused ? color.focusText : onSearch() ? color.accentText : color.text}
              />
            </View>
          )}
        </RoundItem>
        {/* Spacer and tabs: rebuilt once the tabs' width is known (the libraries load), so the
          bar lays them out centered again. More than MAX_TABS: a window of them that slides
          as focus moves past its edges (tabs outside it aren't drawn). */}
        <Show when={tabsW()} keyed>
          {_width => (
            <>
              <View width={spacer()} height={H} skipFocus />
              <View width={tabsW()} height={H} forwardFocus={0}>
                <Row
                  x={-first() * (TAB_W + GAP)}
                  transition={{ x: { duration: 200, easing: "ease-out" } }}
                  width={many() ? tabs().length * (TAB_W + GAP) : tabsW()}
                  height={H}
                  gap={GAP}
                  scroll="none"
                  selected={Math.max(0, currentTab())}
                >
                  <For each={tabs()}>
                    {(tab, i) => (
                      <Tab
                        label={tab.label}
                        width={tabW(tab.label)}
                        active={i() === currentTab()}
                        hidden={many() && (i() < first() || i() >= first() + MAX_TABS)}
                        onFocused={() => keepInWindow(i())}
                        onSelect={() => go(tab.path)}
                      />
                    )}
                  </For>
                </Row>
              </View>
            </>
          )}
        </Show>
      </Row>
      <Text
        x={screen.width - screen.gutter}
        mountX={1}
        y={Y + H + 14}
        fontSize={20}
        color={color.warning}
        alpha={offline().length ? 1 : 0}
      >
        {offline().length
          ? t("{names} offline: check the NAS", { names: displayText(offline().join(", ")) })
          : " "}
      </Text>
    </View>
  );
}
