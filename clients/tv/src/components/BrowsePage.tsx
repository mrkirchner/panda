import { createSignal, For, Show, type Resource } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { imageUrl } from "../api/client";
import type { GenrePage, Spot } from "../api/types";
import { Backdrop } from "./Backdrop";
import { PillButton } from "./Button";
import { CardRow, GhostRow } from "./CardRow";
import { HEADER_H, HeaderArea, PageRows } from "./PageRows";
import { TopBar } from "./TopBar";
import { displayText } from "../format";
import { t, tn } from "../i18n";
import { focusTopBar, useNavigate } from "../nav";
import { logoOf, spotMeta, spotPath, spotReason } from "../spots";
import { theme, withAlpha } from "../theme";

const { screen, color, font } = theme;
const BUTTONS_Y = HEADER_H - 170;

/**
 * A browse page, like a store's: a big name and count over a backdrop with one button (to the
 * full list), then Featured (tall cards), a ranked Top 10, Recently added and a row per genre.
 * The genre pages and the Movies and Shows pages.
 */
export function BrowsePage(props: {
  page: Resource<GenrePage>;
  /** Shown before the page arrives. */
  name: string;
  /** Washes the backdrop (a genre's color). */
  tint?: number;
  /** The button to the full list. */
  allLabel: string;
  onAll: () => void;
  /** The Top 10 row's title. */
  topTitle: (p: GenrePage) => string;
  /** Shown when there's no page. */
  empty: string;
  /** A main page (Movies, Shows): the top bar has its tabs. */
  main?: boolean;
}) {
  const navigate = useNavigate();
  /** The page once loaded (a failed load reads as none, never throws). */
  const data = () => (props.page.error ? undefined : props.page());
  const [onHeader, setOnHeader] = createSignal(true);
  let buttonsRef: ElementNode | undefined;
  const open = (s: Spot) => navigate(spotPath(s));
  const poster = (s: Spot, rank?: number) => ({
    width: 0,
    height: 0,
    image: imageUrl(s.poster),
    title: s.title,
    rank,
    onSelect: () => open(s),
  });
  const feature = (s: Spot) => ({
    width: 0,
    height: 0,
    image: imageUrl(s.backdrop ?? s.poster),
    logo: logoOf(s),
    title: s.title,
    meta: spotMeta(s),
    reason: spotReason(s),
    onSelect: () => open(s),
  });
  const count = () => {
    const n = data()?.count ?? 0;
    return n ? tn(n, "{n} title", "{n} titles") : "";
  };

  return (
    <View onMenu={props.main ? focusTopBar : undefined}>
      <Backdrop src={imageUrl(data()?.backdrop)} dim={!onHeader()} />
      <Show when={props.tint !== undefined}>
        <View
          width={screen.width}
          height={screen.height}
          colorTop={withAlpha(props.tint!, 0x30)}
          colorBottom={withAlpha(props.tint!, 0x10)}
          alpha={onHeader() ? 1 : 0}
          transition={{ alpha: { duration: 300 } }}
        />
      </Show>
      <Show when={props.page.error}>
        <Text x={screen.gutter} y={HEADER_H - 60} fontSize={font.body} color={color.textMuted}>
          {props.empty}
        </Text>
      </Show>
      <PageRows onHeaderFocused={setOnHeader} onTopUp={focusTopBar}>
        <HeaderArea visible={onHeader()}>
          <Text
            x={screen.gutter}
            y={BUTTONS_Y - 40}
            mountY={1}
            width={screen.width - screen.gutter * 2}
            contain="width"
            maxLines={1}
            fontSize={120}
            fontFamily="Roboto700"
            color={color.text}
          >
            {props.name}
          </Text>
          <Text x={screen.gutter} y={BUTTONS_Y - 30} fontSize={font.caption} color={color.textMuted}>
            {count() || " "}
          </Text>
          <View
            ref={buttonsRef}
            x={screen.gutter}
            y={BUTTONS_Y + 20}
            width={600}
            height={64}
            forwardFocus={0}
            autofocus
          >
            <PillButton primary label={props.allLabel} width={260} onSelect={props.onAll} />
          </View>
          <TopBar visible={onHeader()} onDown={() => (buttonsRef?.setFocus(), true)} />
        </HeaderArea>

        <Show
          when={data()}
          fallback={
            <Show when={!props.page.error}>
              <GhostRow variant="tall" />
            </Show>
          }
        >
          {p => (
            <>
              <Show when={p().featured.length > 0}>
                <CardRow<Spot> title={t("Featured")} variant="tall" items={p().featured} card={feature} />
              </Show>
              <Show when={p().top.length > 0}>
                <CardRow<Spot>
                  title={props.topTitle(p())}
                  ranked
                  items={p().top}
                  card={s => poster(s, p().top.indexOf(s) + 1)}
                />
              </Show>
              <Show when={p().recent.length > 0}>
                <CardRow<Spot> title={t("Recently added")} items={p().recent} card={s => poster(s)} />
              </Show>
              <For each={p().paired}>
                {row => (
                  <CardRow<Spot> title={displayText(row.genre)} items={row.items} card={s => poster(s)} />
                )}
              </For>
            </>
          )}
        </Show>
      </PageRows>
    </View>
  );
}
