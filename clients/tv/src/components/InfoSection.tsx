import { createSignal, For, Show } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import type { TitleDetails, TrackInfo } from "../api/types";
import { displayText, languageName } from "../format";
import { t } from "../i18n";
import { glassEdge, theme } from "../theme";

const { screen, color, font } = theme;

const W = screen.width - screen.gutter * 2;
const ABOUT_H = 300;
/** About this many characters fill the card's three lines; longer plots offer "more". */
const LONG_PLOT = 250;
const COLUMNS_Y = ABOUT_H + 70;
const COL_W = (W - 80) / 3;
/** Room per fact (label plus up to two lines), for the section's height. */
const FACT_H = 88;
/** The section's height: the About card, then three columns of up to five facts. */
export const INFO_H = COLUMNS_Y + 60 + FACT_H * 5 + 40;

/** "English (5.1), Spanish" from a file's tracks; unknown languages left out. */
function trackList(tracks: TrackInfo[] | undefined): string | null {
  const names = (tracks ?? [])
    .map(tr => {
      const name = languageName(tr.language);
      return name ? (tr.detail ? `${name} (${tr.detail})` : name) : null;
    })
    .filter((n): n is string => !!n);
  return names.length ? [...new Set(names)].join(", ") : null;
}

function Column(props: { x: number; heading: string; facts: Fact[] }) {
  const facts = () => props.facts.filter(f => f.value);
  // Stacked (flex), so a value that wraps to two lines pushes the next fact down.
  return (
    <Show when={facts().length > 0}>
      <View
        x={props.x}
        y={COLUMNS_Y}
        width={COL_W}
        display="flex"
        flexDirection="column"
        flexBoundary="contain"
        gap={18}
      >
        <Text fontSize={font.heading} color={color.text}>
          {props.heading}
        </Text>
        <For each={facts()}>
          {f => (
            <View width={COL_W} display="flex" flexDirection="column" flexBoundary="contain" gap={0}>
              <Text fontSize={font.caption} color={color.text}>
                {f.label}
              </Text>
              <Text
                width={COL_W - 20}
                contain="width"
                maxLines={2}
                fontSize={font.caption}
                color={color.textMuted}
              >
                {displayText(f.value)}
              </Text>
            </View>
          )}
        </For>
      </View>
    </Show>
  );
}

/** What the About card opens in full (TextSheet). */
export interface About {
  title: string;
  genres: string;
  text: string;
  refocus: () => void;
}

/** One fact in a column: shown only when it has a value. */
export interface Fact {
  label: string;
  value: string | null | undefined;
}

/**
 * The bottom of a title or show page: an About card (the full plot) and the facts in columns:
 * Information (the page's own), Languages (from the details: original, and your file's audio
 * and subtitles) and Files. Focusable as a whole (no action), so Down reaches it.
 */
export function InfoSection(props: {
  title: string;
  genres: string | null | undefined;
  overview: string | null | undefined;
  details: TitleDetails | undefined;
  information: Fact[];
  files: Fact[];
  /** OK on the About card: show the whole plot; `refocus` puts focus back here afterwards. */
  onExpand: (about: About) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const d = () => props.details;
  const text = () => props.overview ?? d()?.tagline ?? "";
  let node: ElementNode | undefined;
  return (
    <View
      ref={node}
      width={screen.width}
      height={INFO_H}
      onFocusChanged={setFocused}
      onEnter={() => {
        if (text()) {
          props.onExpand({
            title: props.title,
            genres: props.genres ?? "",
            text: text(),
            refocus: () => node?.setFocus(),
          });
        }
        return true;
      }}
    >
      <Text x={screen.gutter} fontSize={font.heading} color={color.text}>
        {t("About")}
      </Text>
      <View
        x={screen.gutter}
        y={60}
        width={W * 0.55}
        height={ABOUT_H - 60}
        borderRadius={theme.radius.lg}
        color={focused() ? theme.glass.regular : theme.glass.thin}
        border={glassEdge(true)}
        transition={{ color: { duration: theme.focus.duration } }}
      >
        <Text
          x={36}
          y={28}
          fontSize={font.heading}
          color={color.text}
          width={W * 0.55 - 72}
          contain="width"
          maxLines={1}
        >
          {displayText(props.title)}
        </Text>
        <Text x={36} y={78} fontSize={20} letterSpacing={1.5} color={color.textMuted}>
          {displayText(props.genres ?? "").toUpperCase()}
        </Text>
        <Text
          x={36}
          y={112}
          // Room on the right for "MORE", at the end of the last line.
          width={W * 0.55 - 72 - 110}
          contain="width"
          maxLines={3}
          lineHeight={font.caption * 1.35}
          fontSize={font.caption}
          color={color.text}
        >
          {displayText(text())}
        </Text>
        {/* A plot longer than the card shows: OK opens it in full. */}
        <Text
          x={W * 0.55 - 36}
          mountX={1}
          y={112 + font.caption * 1.35 * 2 + 4}
          fontSize={20}
          letterSpacing={1.5}
          color={focused() ? color.text : color.textMuted}
          alpha={text().length > LONG_PLOT ? 1 : 0}
        >
          {t("MORE")}
        </Text>
      </View>
      <Column x={screen.gutter} heading={t("Information")} facts={props.information} />
      <Column
        x={screen.gutter + COL_W + 40}
        heading={t("Languages")}
        facts={[
          { label: t("Original language"), value: languageName(d()?.original_language) },
          // Versions whose languages differ: each one's, by its name (Play picks the one that
          // suits this TV).
          ...(d()?.version_languages?.length
            ? d()!.version_languages!.flatMap(v => [
                { label: `${t("Audio")} · ${v.label}`, value: trackList(v.audio) },
                { label: `${t("Subtitles")} · ${v.label}`, value: trackList(v.subtitles) },
              ])
            : [
                { label: t("Audio"), value: trackList(d()?.audio) },
                { label: t("Subtitles"), value: trackList(d()?.subtitles) },
              ]),
        ]}
      />
      <Column x={screen.gutter + (COL_W + 40) * 2} heading={t("Files")} facts={props.files} />
    </View>
  );
}
