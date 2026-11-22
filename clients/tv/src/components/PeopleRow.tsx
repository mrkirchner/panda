import { createSignal, For, Show } from "solid-js";
import { useNavigate } from "../nav";
import { Text, View } from "@solidtv/solid";
import { Row } from "@solidtv/solid/primitives";
import { imageUrl } from "../api/client";
import type { Person } from "../api/types";
import { displayText } from "../format";
import { theme } from "../theme";
import { usePositions } from "../focusMemory";
import { FocusRing } from "./FocusRing";
import { Label } from "./Label";

const { screen, color, font, focus } = theme;
const FACE = 150;
const CARD_W = 190;
/** Heading band: room for the title plus a focused face growing toward it, and its ring. */
const TITLE_H = 84;
/** Untitled (under a page's tabs): just room for a focused face's grow and ring. */
const UNTITLED_H = theme.tabContentTop;

/** "Timothée Chalamet" -> "TC". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join("");

function PersonCard(props: { person: Person }) {
  const navigate = useNavigate();
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={CARD_W}
      height={FACE + 100}
      onFocusChanged={setFocused}
      // Their page: other movies and shows they're in.
      onEnter={() => {
        if (props.person.id) navigate(`/person/${props.person.id}`);
        return true;
      }}
    >
      <View
        x={(CARD_W - FACE) / 2}
        width={FACE}
        height={FACE}
        borderRadius={FACE / 2}
        color={theme.glass.thin}
        scale={focused() ? 1.08 : 1}
        transition={{ scale: { duration: focus.duration, easing: "ease-out" } }}
      >
        {/* Initials under the photo: shown when there's no headshot. */}
        <Label
          text={initials(props.person.name)}
          width={FACE}
          height={FACE}
          size={44}
          color={color.textMuted}
          // Text draws after shapes, so it would show through the photo.
          alpha={props.person.image ? 0 : 1}
        />
        <Show when={props.person.image}>
          <View
            width={FACE}
            height={FACE}
            borderRadius={FACE / 2}
            src={imageUrl(props.person.image)}
            textureOptions={{ resizeMode: { type: "cover" } }}
          />
        </Show>
        <FocusRing
          width={FACE}
          height={FACE}
          radius={FACE / 2}
          ringWidth={theme.focus.ringWidthRound}
          visible={focused()}
        />
      </View>
      <Text
        y={FACE + 22}
        width={CARD_W}
        contain="width"
        maxLines={1}
        textAlign="center"
        fontSize={font.caption}
        color={focused() ? color.text : color.textMuted}
      >
        {displayText(props.person.name)}
      </Text>
      <Text
        y={FACE + 54}
        width={CARD_W}
        contain="width"
        maxLines={1}
        textAlign="center"
        fontSize={20}
        color={color.textMuted}
        alpha={props.person.role ? 0.8 : 0}
      >
        {displayText(props.person.role) || " "}
      </Text>
    </View>
  );
}

/** "Cast & Crew": round headshots with name and role, directors first. A page row. */
export function PeopleRow(props: { title: string; people: Person[] }) {
  const top = () => (props.title ? TITLE_H : UNTITLED_H);
  // Back to this page: the person you left from is focused again (focusMemory.ts).
  const positions = usePositions();
  const slot = `people:${props.title}`;
  const saved = positions?.get<number>(slot) ?? 0;
  return (
    <View width={screen.width} height={top() + FACE + 100} forwardFocus={1} rowKey={props.title}>
      <Text x={screen.gutter} y={0} fontSize={font.heading} color={color.text}>
        {props.title}
      </Text>
      <Row
        x={screen.gutter}
        y={top()}
        width={screen.width - screen.gutter}
        height={FACE + 100}
        gap={theme.space.item}
        scroll="auto"
        selected={Math.min(saved, Math.max(0, props.people.length - 1))}
        onSelectedChanged={(i: number) => {
          positions?.set(slot, i);
        }}
      >
        <For each={props.people}>{p => <PersonCard person={p} />}</For>
      </Row>
    </View>
  );
}
