import { createSignal, Show } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { displayText, formatTime } from "../format";
import { logicalPixelRatio } from "#devices/resolution";
import { theme } from "../theme";
import { FocusRing } from "./FocusRing";
import { IconButton } from "./IconButton";
import { t } from "../i18n";

const { screen, color, font } = theme;
const BAR_X = screen.gutter;
const BAR_W = screen.width - screen.gutter * 2;
const BAR_Y = 850;
const BUTTONS_Y = 900;
const BTN = 84;
const BTN_MAIN = 104;
/** Transport (back, play, forward) centered on screen; settings follow after a gap. */
const SETTINGS_GAP = 160;
const TRANSPORT_W = BTN * 2 + BTN_MAIN + 40 * 2;
const ROW_X = (screen.width - TRANSPORT_W) / 2;
const ROW_W = TRANSPORT_W + SETTINGS_GAP + BTN * 2 + 40;
/** Frame preview above the scrub knob (16:9). */
export const PREVIEW = { width: 320, height: 180 };

/** The scrub preview to show: a small JPEG of the frame at the scrub target. */
export interface PreviewFrame {
  src: string;
}

/**
 * Bottom overlay: title, a seek bar you can scrub, and play/skip/subtitle/quality buttons.
 * Always mounted; it fades with `alpha`, so showing and hiding never builds nodes.
 *
 * Focus: the button row (Left/Right between buttons) and, above it, the seek bar (Left/Right
 * scrub, OK jumps there). The parent decides where focus lands when the controls appear.
 */
export function PlayerControls(props: {
  visible: boolean;
  title: string;
  subtitle?: string;
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  /** "Auto: 1080p HEVC 4.8 Mbps (videotoolbox)". */
  info: string;
  /** Where a scrub would land, while one is pending (the knob and time follow it). */
  scrubTarget: number | null;
  /** Thumbnail for `scrubTarget`, when the server has made them. */
  preview: PreviewFrame | null;
  barRef: (el: ElementNode) => void;
  playRef: (el: ElementNode) => void;
  onTogglePlay: () => void;
  onSkip: (delta: number) => void;
  onScrub: (delta: number) => void;
  onScrubCommit: () => void;
  /** Pointer: jump to this fraction of the bar. */
  onScrubTo: (fraction: number) => void;
  onSubtitles: () => void;
  onAudio: () => void;
  /** Only when there's something to choose: subtitles at all, more than one audio track. */
  showSubtitles: boolean;
  showAudio: boolean;
  onQuality: () => void;
}) {
  const [barFocused, setBarFocused] = createSignal(false);
  const shown = () => props.scrubTarget ?? props.position;
  const ratio = () => (props.duration > 0 ? Math.min(1, Math.max(0, shown() / props.duration)) : 0);
  const knobX = () => BAR_X + BAR_W * ratio();
  // Buffering shows as the loading dots over the picture, not as text here.
  const state = () => (props.buffering || props.playing ? "" : t("Paused"));
  // Keep the preview on screen near the ends of the bar.
  const previewX = () =>
    Math.min(BAR_X + BAR_W - PREVIEW.width, Math.max(BAR_X, knobX() - PREVIEW.width / 2));
  const scrubbing = () => props.scrubTarget !== null;
  /** A frame preview is up: the title and details under it step aside. */
  const previewing = () => scrubbing() && Boolean(props.preview);

  return (
    <View
      width={screen.width}
      height={screen.height}
      alpha={props.visible ? 1 : 0}
      transition={{ alpha: { duration: 200 } }}
      zIndex={20}
    >
      {/* Scrim so white text is readable over bright video. */}
      <View
        y={screen.height - 480}
        width={screen.width}
        height={480}
        colorTop={0x00000000}
        colorBottom={0x000000e6}
        zIndex={20}
      />
      <Text
        x={BAR_X}
        y={720}
        width={BAR_W}
        contain="width"
        maxLines={1}
        fontSize={font.title}
        color={color.text}
        alpha={previewing() ? 0 : 1}
        zIndex={21}
      >
        {displayText(props.title) || " "}
      </Text>
      <Text
        x={BAR_X}
        y={790}
        fontSize={font.caption}
        color={color.textMuted}
        alpha={previewing() ? 0 : 1}
        zIndex={21}
      >
        {displayText(props.subtitle) || " "}
      </Text>

      {/* zIndex: layers are per parent, so the whole column must sit above the scrim. */}
      <Column
        x={0}
        y={BAR_Y - 24}
        width={screen.width}
        height={240}
        gap={0}
        scroll="none"
        selected={1}
        zIndex={21}
      >
        {/* Seek bar: focusable; Left/Right scrub, OK (or a pointer click) jumps. */}
        <View
          ref={props.barRef}
          x={BAR_X}
          width={BAR_W}
          height={48}
          zIndex={21}
          onFocusChanged={(f: boolean) => {
            setBarFocused(f);
          }}
          onLeft={() => (props.onScrub(-1), true)}
          onRight={() => (props.onScrub(1), true)}
          onEnter={(e: unknown) => {
            // A pointer click carries where on the bar it landed.
            if (e instanceof MouseEvent) props.onScrubTo(pointerFraction(e));
            else props.onScrubCommit();
            return true;
          }}
        >
          <View
            y={20}
            width={BAR_W}
            height={barFocused() ? 10 : 6}
            borderRadius={5}
            color={0xffffff40}
            zIndex={21}
          />
          <View
            y={20}
            width={Math.max(8, BAR_W * ratio())}
            height={barFocused() ? 10 : 6}
            borderRadius={5}
            color={color.accent}
            zIndex={21}
          />
          <View
            x={BAR_W * ratio() - (barFocused() ? 16 : 10)}
            y={barFocused() ? 9 : 13}
            width={barFocused() ? 32 : 20}
            height={barFocused() ? 32 : 20}
            borderRadius={16}
            color={color.text}
            transition={{ width: { duration: 120 }, height: { duration: 120 } }}
            zIndex={22}
          />
        </View>
        {/* Buttons: skip/play centered, subtitles/quality on the right. */}
        <View width={screen.width} height={180} forwardFocus={0}>
          <Row
            x={ROW_X}
            y={BUTTONS_Y - BAR_Y}
            width={ROW_W}
            height={BTN_MAIN}
            gap={40}
            alignItems="center"
            scroll="none"
            selected={1}
          >
            <IconButton
              z={22}
              icon="back10"
              size={BTN}
              label={t("Back 10s")}
              onSelect={() => props.onSkip(-10)}
            />
            <IconButton
              z={22}
              ref={props.playRef}
              icon={props.playing ? "pause" : "play"}
              size={BTN_MAIN}
              label={props.playing ? t("Pause") : t("Play")}
              onSelect={props.onTogglePlay}
            />
            <IconButton
              z={22}
              icon="fwd10"
              size={BTN}
              label={t("Forward 10s")}
              onSelect={() => props.onSkip(10)}
            />
            {/* Gap between the transport and the settings group. */}
            <View width={SETTINGS_GAP - 40} height={BTN} skipFocus />
            <Show when={props.showSubtitles}>
              <IconButton
                z={22}
                icon="subtitles"
                size={BTN}
                label={t("Subtitles")}
                onSelect={props.onSubtitles}
              />
            </Show>
            <Show when={props.showAudio}>
              <IconButton z={22} icon="audio" size={BTN} label={t("Audio")} onSelect={props.onAudio} />
            </Show>
            <IconButton z={22} icon="quality" size={BTN} label={t("Quality")} onSelect={props.onQuality} />
          </Row>
        </View>
      </Column>

      {/* Times under the bar: where you are (or would land) and what's left. */}
      <Text x={BAR_X} y={BAR_Y + 30} fontSize={font.caption} color={color.text} zIndex={21}>
        {formatTime(shown())}
      </Text>
      <Text
        x={BAR_X + BAR_W}
        mountX={1}
        y={BAR_Y + 30}
        fontSize={font.caption}
        color={color.text}
        zIndex={21}
      >
        {props.duration > 0 ? `-${formatTime(Math.max(0, props.duration - shown()))}` : " "}
      </Text>
      {/* State and stream details, right-aligned on the title's line. */}
      <Text
        x={BAR_X + BAR_W}
        mountX={1}
        y={800}
        fontSize={20}
        color={color.textMuted}
        alpha={previewing() ? 0 : 1}
        zIndex={21}
      >
        {displayText([state(), props.info].filter(Boolean).join(" · ")) || " "}
      </Text>

      {/* Scrub preview: the frame (when thumbnails exist) and the target time above the knob. */}
      <View
        x={previewX()}
        y={BAR_Y - 24 - PREVIEW.height - 64}
        width={PREVIEW.width}
        height={PREVIEW.height + 56}
        alpha={previewing() ? 1 : 0}
        zIndex={23}
        skipFocus
      >
        <Show when={props.preview}>
          {p => (
            <View
              width={PREVIEW.width}
              height={PREVIEW.height}
              borderRadius={10}
              color={0x000000ff}
              zIndex={23}
            >
              <View
                src={p().src}
                width={PREVIEW.width}
                height={PREVIEW.height}
                // Scope films (2.39:1) letterbox inside the 16:9 box instead of stretching.
                textureOptions={{ resizeMode: { type: "contain" } }}
                borderRadius={10}
                zIndex={23}
              />
              <FocusRing width={PREVIEW.width} height={PREVIEW.height} radius={10} visible />
            </View>
          )}
        </Show>
        <View
          x={PREVIEW.width / 2}
          mountX={0.5}
          // Under the frame, or just above the bar when there's no frame.
          y={PREVIEW.height + 12}
          width={130}
          height={40}
          borderRadius={20}
          color={color.focusFill}
          zIndex={23}
        >
          <Text
            width={130}
            y={8}
            contain="width"
            textAlign="center"
            fontSize={22}
            color={color.focusText}
            zIndex={24}
          >
            {formatTime(shown())}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Where along the seek bar a pointer click landed (0-1), on the 1920x1080 design grid. */
function pointerFraction(e: MouseEvent) {
  const x = e.clientX / logicalPixelRatio;
  return Math.min(1, Math.max(0, (x - BAR_X) / BAR_W));
}
