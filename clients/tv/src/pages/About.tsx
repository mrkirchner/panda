import { createResource, For, Show } from "solid-js";
import { Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { useNavigate } from "@solidjs/router";
import { api } from "../api/client";
import type { Credit } from "../api/types";
import { PillButton } from "../components/Button";
import { displayText } from "../format";
import { t } from "../i18n";
import { theme } from "../theme";

const { screen, color, font } = theme;
const X = screen.gutter;
const W = 1300;
const TMDB_LOGO_W = 320;
/** The logo's own proportions (273.42 x 35.52). */
const TMDB_LOGO_H = Math.round((TMDB_LOGO_W * 35.52) / 273.42);
const ROW_H = 150;

/**
 * Where Panda's information comes from, with the credit each provider's terms ask for (TMDB's
 * logo and notice among them). From Who's watching; open to everyone.
 */
export default function About() {
  const navigate = useNavigate();
  const [list] = createResource(() => api.credits().catch(() => [] as Credit[]));
  const credits = () => list() ?? [];
  return (
    <View width={screen.width} height={screen.height}>
      <Text x={X} y={110} fontSize={font.title} color={color.text}>
        {t("About Panda")}
      </Text>
      <Text x={X} y={190} width={W} contain="width" fontSize={font.body} color={color.textMuted}>
        {t("Titles, artwork, episodes and ratings come from these services:")}
      </Text>
      <Column x={X} y={270} width={W} height={ROW_H * Math.max(1, credits().length)} gap={0} scroll="none">
        <For each={credits()}>
          {c => (
            <View width={W} height={ROW_H}>
              <Show
                when={c.id === "tmdb"}
                fallback={
                  <Text fontSize={font.heading} color={color.text}>
                    {displayText(c.name)}
                  </Text>
                }
              >
                <View
                  y={6}
                  width={TMDB_LOGO_W}
                  height={TMDB_LOGO_H}
                  src={`images/tmdb.svg?s=${TMDB_LOGO_W}`}
                />
              </Show>
              <Text y={56} width={W} contain="width" maxLines={2} fontSize={font.body} color={color.text}>
                {displayText(c.credit)}
              </Text>
              <Text y={98} fontSize={font.caption} color={color.textMuted}>
                {displayText(c.site.replace(/^https?:\/\/(www\.)?/, ""))}
              </Text>
            </View>
          )}
        </For>
      </Column>
      {/* Panda's own license and the bundled software's (LEGAL.md has them all, with links). */}
      <Text
        x={X + 240 + theme.space.item}
        y={screen.height - screen.gutter - 64}
        width={screen.width - X * 2 - 240 - theme.space.item}
        contain="width"
        maxLines={2}
        lineHeight={font.caption * 1.35}
        fontSize={font.caption}
        color={color.textMuted}
      >
        {t(
          "Panda is open source under the Apache License 2.0. It uses FFmpeg (LGPL/GPL), Roboto (Apache 2.0) and Noto Sans (SIL OFL 1.1). Full credits and licenses: LEGAL.md in the source.",
        )}
      </Text>
      <View x={X} y={screen.height - screen.gutter - 64} width={240} height={64} forwardFocus={0}>
        <PillButton label={t("Back")} width={240} autofocus onSelect={() => navigate(-1)} />
      </View>
    </View>
  );
}
