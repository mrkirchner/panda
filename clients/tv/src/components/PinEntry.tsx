import { createSignal, For, onMount } from "solid-js";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { theme } from "../theme";
import { t } from "../i18n";
import { NumberPadSheet, useTypedInput } from "./Keyboard";

const { screen, color, font } = theme;
const BOX_W = 96;
const BOX_H = 112;
const BOX_GAP = 24;
const DOT = 26;
const MIN = 4;
const MAX = 8;

/**
 * PIN entry: a row of boxes (a dot per digit, so the PIN isn't shown on a big screen) and a
 * number pad sheet. Remote number keys and a real keyboard type too. 4-8 digits; Done submits,
 * Back cancels.
 */
export function PinEntry(props: {
  /** "PIN for Sam", "Enter the current PIN"... */
  title: string;
  error: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = createSignal("");
  const [hint, setHint] = createSignal("");
  let padRef: ElementNode | undefined;
  onMount(() => setTimeout(() => padRef?.setFocus(), 0));

  const add = (d: string) => {
    setHint("");
    setPin(p => (p.length < MAX ? p + d : p));
  };
  const remove = () => setPin(p => p.slice(0, -1));
  const submit = () => {
    if (pin().length < MIN) return setHint(t("A PIN is 4 to 8 digits"));
    props.onSubmit(pin());
    setPin("");
  };
  useTypedInput({
    enabled: () => true,
    hasText: () => pin().length > 0,
    onType: ch => {
      if (/^[0-9]$/.test(ch)) add(ch);
    },
    onDelete: remove,
  });

  /** Boxes: four, growing with longer PINs up to eight. */
  const boxes = () => Math.min(MAX, Math.max(MIN, pin().length + (pin().length >= MIN ? 1 : 0)));
  const rowW = () => boxes() * BOX_W + (boxes() - 1) * BOX_GAP;
  const message = () => props.error || hint();

  return (
    <View width={screen.width} height={screen.height}>
      <Text x={screen.width / 2} mountX={0.5} y={170} fontSize={font.title} color={color.text}>
        {props.title}
      </Text>
      <View x={(screen.width - rowW()) / 2} y={300} width={rowW()} height={BOX_H}>
        <For each={Array.from({ length: boxes() }, (_, i) => i)}>
          {i => (
            <View
              x={i * (BOX_W + BOX_GAP)}
              width={BOX_W}
              height={BOX_H}
              borderRadius={theme.radius.sm}
              color={theme.glass.thin}
              // The next digit goes here.
              border={{
                width: i === pin().length ? 3 : 2,
                color: i === pin().length ? color.accent : theme.glass.edge,
              }}
            >
              <View
                x={(BOX_W - DOT) / 2}
                y={(BOX_H - DOT) / 2}
                width={DOT}
                height={DOT}
                borderRadius={DOT / 2}
                color={color.text}
                alpha={i < pin().length ? 1 : 0}
              />
            </View>
          )}
        </For>
      </View>
      <Text
        x={screen.width / 2}
        mountX={0.5}
        y={460}
        fontSize={font.caption}
        color={message() ? color.error : color.textMuted}
      >
        {message() || t("Enter 4 to 8 digits")}
      </Text>
      <NumberPadSheet
        open
        ref={el => (padRef = el)}
        onDigit={add}
        onDelete={remove}
        onDone={submit}
        onBack={props.onCancel}
      />
    </View>
  );
}
