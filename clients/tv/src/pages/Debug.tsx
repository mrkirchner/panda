import { createResource, createSignal, For, Show } from "solid-js";
import { renderer, Text, View } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { api } from "../api/client";
import { getServer } from "../api/server";
import { SettingRow } from "../components/SettingRow";
import { displayText } from "../format";
import { t } from "../i18n";
import { config as deviceConfig } from "#device";
import { resetDebug, setShowFps, setTracing, showFps, traceOn } from "#devices/debug";
import {
  autoResolution,
  resolution,
  saveResolution,
  storedResolution,
  type Resolution,
} from "#devices/resolution";
import { detectedTier, saveTierChoice, tier, tierChoice, type TierChoice } from "#devices/tier";
import { theme } from "../theme";

const { screen, color, font } = theme;
const X = screen.gutter;
const INFO_X = X + 860 + 80;
const INFO_W = screen.width - screen.gutter - INFO_X;

/** The renderer samples frame times only while the FPS meter shows. */
const applyFps = (interval: number) => {
  // The WebGL renderer can change this while running (the DOM renderer has no meter).
  if (renderer && "setOptions" in renderer) renderer.setOptions({ fpsUpdateInterval: interval });
};

/**
 * Testing tools for this TV (admins' TVs only, from Who's watching): performance tier, resolution, the FPS meter and
 * request tracing, kept on the device, plus what the device reports about itself. For trying a
 * new TV: switch the tier and resolution and watch the meter.
 */
export default function Debug() {
  // The same check as Who's watching's Debug button: this TV belongs to an admin's account.
  const [device] = createResource(() => api.deviceProfiles().catch(() => null));
  return (
    <Show
      when={device()?.admin}
      fallback={
        <Show when={device.state === "ready" || device.state === "errored"}>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("Only admins can open this page.")}
          </Text>
        </Show>
      }
    >
      <DebugView />
    </Show>
  );
}

function DebugView() {
  // A browser restarts by reloading; the Apple TV app can't restart itself, so its changes
  // wait for the next launch.
  const canRestart = deviceConfig.name !== "appletv" && typeof location?.reload === "function";
  const restart = () => setTimeout(() => location.reload(), 700);
  const later = (label: string, changed: boolean) =>
    changed && !canRestart ? `${label} · ${t("next launch")}` : label;

  const [tierPick, setTierPick] = createSignal<TierChoice>(tierChoice());
  const tierName = (x: "low" | "high") => (x === "low" ? t("Low") : t("High"));
  const tierLabel = () =>
    later(
      tierPick() === "auto"
        ? t("Auto ({tier})", { tier: tierName(detectedTier()) })
        : tierName(tierPick() as "low" | "high"),
      (tierPick() === "auto" ? detectedTier() : tierPick()) !== tier,
    );
  const cycleTier = () => {
    const next: TierChoice = tierPick() === "auto" ? "high" : tierPick() === "high" ? "low" : "auto";
    setTierPick(next);
    saveTierChoice(next);
    if (canRestart) restart();
  };

  const [resPick, setResPick] = createSignal<Resolution | null>(storedResolution());
  const resLabel = () =>
    later(
      resPick() === null ? t("Auto ({res})", { res: `${autoResolution()}p` }) : `${resPick()}p`,
      (resPick() ?? autoResolution()) !== resolution,
    );
  const cycleRes = () => {
    const next: Resolution | null = resPick() === null ? 1080 : resPick() === 1080 ? 720 : null;
    setResPick(next);
    saveResolution(next);
    if (canRestart) restart();
  };

  const nav =
    typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number });
  const info = (): [string, string][] => [
    [t("Device"), deviceConfig.name],
    [t("Running"), `${tierName(tier)} · ${resolution}p`],
    [t("Detected"), `${tierName(detectedTier())} · ${autoResolution()}p`],
    [t("Memory"), nav?.deviceMemory ? `${nav.deviceMemory} GB` : t("Not reported")],
    [t("Cores"), nav?.hardwareConcurrency ? String(nav.hardwareConcurrency) : t("Not reported")],
    [
      t("Screen"),
      typeof window === "undefined"
        ? "-"
        : `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio ?? 1}x`,
    ],
    [t("Server"), getServer() ?? "-"],
    [t("Browser"), nav?.userAgent ?? "-"],
  ];

  return (
    <View>
      <Text x={X} y={110} fontSize={font.title} color={color.text}>
        {t("Debug (this TV)")}
      </Text>
      <Text x={X} y={190} width={860} fontSize={font.caption} color={color.textMuted} contain="width">
        {t("Testing tools for this TV only. Performance and resolution restart the app.")}
      </Text>
      <Column x={X} y={260} width={860} gap={theme.space.list} scroll="none" autofocus>
        <SettingRow label={t("Performance")} value={tierLabel()} icon="chevron" onSelect={cycleTier} />
        <SettingRow label={t("Resolution")} value={resLabel()} icon="chevron" onSelect={cycleRes} />
        <SettingRow
          label={t("FPS meter")}
          value={showFps() ? t("On") : t("Off")}
          icon="chevron"
          onSelect={() => setShowFps(!showFps(), applyFps)}
        />
        <SettingRow
          label={t("Request tracing")}
          value={traceOn() ? t("On") : t("Off")}
          icon="chevron"
          onSelect={() => setTracing(!traceOn())}
        />
        <SettingRow
          label={t("Reset to defaults")}
          icon="chevron"
          onSelect={() => {
            resetDebug(applyFps);
            saveTierChoice("auto");
            saveResolution(null);
            setTierPick("auto");
            setResPick(null);
            if (canRestart) restart();
          }}
        />
      </Column>
      {/* What the device reports, for telling TVs apart when testing. */}
      <View x={INFO_X} y={260} width={INFO_W}>
        <For each={info()}>
          {([label, value], i) => (
            <View y={i() * 74} width={INFO_W} height={70}>
              <Text fontSize={font.caption - 4} color={color.textMuted}>
                {label}
              </Text>
              <Text
                y={30}
                width={INFO_W}
                maxLines={label === t("Browser") ? 3 : 1}
                contain="width"
                fontSize={font.caption}
                color={color.text}
              >
                {displayText(value)}
              </Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}
