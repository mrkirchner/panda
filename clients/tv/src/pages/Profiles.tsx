import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { api, ensureSession, HttpError, resetSession } from "../api/client";
import type { DeviceProfile } from "../api/types";
import { currentUser, setDeviceSecret, setToken } from "../api/session";
import { Avatar } from "../components/Avatar";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { OPTICAL_Y } from "../components/Label";
import { FocusRing } from "../components/FocusRing";
import { PillButton } from "../components/Button";
import { PinEntry } from "../components/PinEntry";
import { displayText } from "../format";
import { glassEdge, theme } from "../theme";
import { t } from "../i18n";

const { screen, color, font } = theme;
const SIZE = 200;
/** About and Debug, in the bottom corners. */
const SIDE_BUTTON_W = 180;
/** The server's limit: a household, or one TV's own list, holds at most this many. */
const MAX_PROFILES = 8;

/** Name size under a tile: smaller once the row is full and the tiles shrink. */
const nameSize = (tile: number) => (tile >= 180 ? font.body : font.caption);

function ProfileTile(props: { p: DeviceProfile; size: number; editing: boolean; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={props.size + 40}
      height={props.size + 110}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <View x={20} width={props.size} height={props.size} scale={focused() ? 1.1 : 1}>
        <Avatar name={props.p.display_name || props.p.username} size={props.size} picture={props.p.avatar} />
        {/* Edit mode: a pencil badge on the avatar's lower right (above the focus ring, z 30), so it's clear OK edits it.
            (Not an overlay across the avatar: text draws after shapes, so an initial letter
            would sit on top of it.) */}
        <View
          x={props.size - 64}
          y={props.size - 64}
          width={64}
          height={64}
          borderRadius={32}
          color={color.focusFill}
          border={{ width: 4, color: color.background }}
          alpha={props.editing ? 1 : 0}
          scale={props.editing ? 1 : 0.6}
          transition={{
            alpha: { duration: theme.focus.duration },
            scale: { duration: theme.focus.duration },
          }}
          zIndex={31}
        >
          <View
            src="images/icons/pencil.svg"
            x={16}
            y={16}
            width={32}
            height={32}
            color={color.focusText}
            zIndex={32}
          />
        </View>
        <FocusRing
          width={props.size}
          height={props.size}
          radius={props.size / 2}
          ringWidth={theme.focus.ringWidthRound}
          visible={focused()}
        />
      </View>
      {/* One line, "..." when it doesn't fit; smaller when the row is full. */}
      <Text
        y={props.size + 30}
        width={props.size + 40}
        contain="width"
        maxLines={1}
        textAlign="center"
        fontSize={nameSize(props.size)}
        color={focused() ? color.text : color.textMuted}
      >
        {displayText(props.p.display_name || props.p.username)}
      </Text>
      <Show when={props.p.has_pin}>
        <Text
          y={props.size + 72}
          width={props.size + 40}
          contain="width"
          textAlign="center"
          fontSize={20}
          color={color.textMuted}
        >
          PIN
        </Text>
      </Show>
    </View>
  );
}

/** The "+" at the end of the row: adds a profile to this TV's account. */
function AddTile(props: { size: number; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const icon = () => Math.round(props.size * 0.36);
  return (
    <View
      width={props.size + 40}
      height={props.size + 110}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <View
        x={20}
        width={props.size}
        height={props.size}
        borderRadius={props.size / 2}
        color={focused() ? theme.glass.thick : theme.glass.thin}
        border={glassEdge(!focused())}
        scale={focused() ? 1.1 : 1}
        transition={{ scale: { duration: theme.focus.duration, easing: "ease-out" } }}
      >
        <View
          src="images/icons/plus.svg"
          x={(props.size - icon()) / 2}
          y={(props.size - icon()) / 2}
          width={icon()}
          height={icon()}
          color={color.text}
        />
        <FocusRing
          width={props.size}
          height={props.size}
          radius={props.size / 2}
          ringWidth={theme.focus.ringWidthRound}
          visible={focused()}
        />
      </View>
      <Text
        y={props.size + 30}
        width={props.size + 40}
        contain="width"
        maxLines={1}
        textAlign="center"
        fontSize={nameSize(props.size)}
        color={focused() ? color.text : color.textMuted}
      >
        {t("Add profile")}
      </Text>
    </View>
  );
}

/** Who's watching? Profiles that have added themselves to this TV. */
export default function Profiles() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /** Edit mode: picking a profile opens its Edit profile instead of starting to watch. */
  const [editing, setEditing] = createSignal(params.edit === "1");
  const stopEditing = () => {
    setEditing(false);
    navigate("/profiles", { replace: true });
  };
  let actionsRef: ElementNode | undefined;
  let debugRef: ElementNode | undefined;
  let aboutRef: ElementNode | undefined;
  const [data] = createResource(() =>
    api.deviceProfiles().catch((e: unknown) => {
      // The admin removed this TV: forget its credential and pair again.
      if (e instanceof HttpError && e.status === 401) {
        setDeviceSecret(null);
        navigate("/link", { replace: true });
      }
      throw e;
    }),
  );
  void ensureSession().catch(() => {});
  const [pinFor, setPinFor] = createSignal<DeviceProfile | null>(null);
  const [error, setError] = createSignal("");

  /** Sign in as `p` (its PIN first, if it has one), then watch, or edit it in edit mode. Editing
   * signs in too, so a profile is only ever changed or deleted as itself. */
  async function switchTo(p: DeviceProfile, pin?: string) {
    const next = editing() ? "/profile/edit" : "/";
    if (p.user_id === currentUser()?.id && editing()) return navigate(next);
    if (p.has_pin && pin === undefined) {
      setError("");
      return void setPinFor(p);
    }
    try {
      const res = await api.switchProfile(p.user_id, pin);
      setToken(res.token);
      resetSession();
      await ensureSession();
      setPinFor(null);
      navigate(next, { replace: next === "/" });
    } catch (e) {
      setError(
        (e as Error).message.includes("Too many") ? t("Too many tries. Wait a few minutes.") : t("Wrong PIN"),
      );
    }
  }

  const canAdd = () => (data()?.profiles.length ?? 0) < MAX_PROFILES;

  // An account with one profile has nobody to choose between: go straight to it (its PIN
  // first, if it has one). Opened from the menu (to add a profile) or editing, stay here.
  let skipped = false;
  createEffect(() => {
    const profiles = data()?.profiles;
    if (skipped || !profiles || profiles.length !== 1 || editing() || params.from === "menu") return;
    skipped = true;
    void switchTo(profiles[0]);
  });

  // Add profile: type a name with the on-screen (or a real) keyboard; Done creates it in this
  // TV's account.
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [addError, setAddError] = createSignal("");
  let keyboardRef: ElementNode | undefined;
  let rowRef: ElementNode | undefined;
  const startAdding = () => {
    setNewName("");
    setAddError("");
    setAdding(true);
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const stopAdding = () => {
    setAdding(false);
    setTimeout(() => rowRef?.setFocus(), 0);
  };
  const finishAdding = async () => {
    const name = newName().trim();
    if (!name) return stopAdding();
    try {
      // Then straight to the new profile's Edit page to pick its picture and language.
      const user = await api.createDeviceProfile(name);
      const res = await api.switchProfile(user.id);
      setToken(res.token);
      resetSession();
      await ensureSession();
      setAdding(false);
      navigate("/profile/edit?new=1");
    } catch (e) {
      setAddError((e as Error).message);
    }
  };
  useTypedInput({
    enabled: adding,
    hasText: () => newName().length > 0,
    onType: ch => setNewName(n => (n + ch).slice(0, 32)),
    onDelete: () => setNewName(n => n.slice(0, -1)),
  });
  /** Tiles in the row: the profiles, plus "+" while there's room (not in edit mode). */
  const showAdd = () => canAdd() && !editing();
  const tiles = () => (data()?.profiles.length ?? 0) + (showAdd() ? 1 : 0);
  /** Each tile's slot (tile + gap) shrinks so a full account still fits across the screen. */
  const slot = () => Math.min(SIZE + 80, Math.floor((screen.width - 160) / Math.max(1, tiles())));
  const tileSize = () => slot() - 80;

  return (
    <View
      onBack={() => {
        if (adding()) stopAdding();
        else if (editing()) stopEditing();
        else return false;
        return true;
      }}
    >
      <Show
        when={pinFor()}
        fallback={
          <View>
            <Text x={screen.width / 2} mountX={0.5} y={200} fontSize={font.title} color={color.text}>
              {editing() ? t("Choose a profile to edit") : t("Who's watching?")}
            </Text>
            <Show when={data.error}>
              <Text x={screen.gutter} y={300} fontSize={font.body} color={color.error}>
                {`Couldn't load profiles: ${data.error?.message ?? ""}`}
              </Text>
            </Show>
            {/* Mounted once loaded, so autofocus lands on a profile. Profiles, then actions. */}
            <Show when={data()?.profiles.length}>
              <Column x={0} y={360} width={screen.width} gap={theme.space.block} scroll="none">
                <Row
                  ref={el => (rowRef = el)}
                  x={screen.width / 2}
                  mountX={0.5}
                  width={tiles() * slot() - 40}
                  height={SIZE + 120}
                  gap={theme.space.item}
                  scroll="none"
                  autofocus
                >
                  <For each={data()?.profiles ?? []}>
                    {p => (
                      <ProfileTile
                        p={p}
                        size={tileSize()}
                        editing={editing()}
                        onSelect={() => void switchTo(p)}
                      />
                    )}
                  </For>
                  <Show when={showAdd()}>
                    <AddTile size={tileSize()} onSelect={startAdding} />
                  </Show>
                </Row>
                {/* Edit profiles toggles edit mode. Down: About (and Debug, on admins' TVs). */}
                <Row
                  ref={el => (actionsRef = el)}
                  x={screen.width / 2}
                  mountX={0.5}
                  width={300}
                  height={64}
                  gap={theme.space.item}
                  scroll="none"
                  onDown={() => (!editing() && aboutRef ? (aboutRef.setFocus(), true) : false)}
                >
                  <PillButton
                    primary={editing()}
                    label={editing() ? t("Done") : t("Edit profiles")}
                    width={300}
                    onSelect={() => (editing() ? stopEditing() : setEditing(true))}
                  />
                </Row>
              </Column>
            </Show>
            {/* This TV's testing tools (performance, resolution, FPS meter): admins' TVs only. */}
            <Show when={data()?.admin && !editing()}>
              <View
                ref={el => (debugRef = el)}
                x={screen.width - screen.gutter - SIDE_BUTTON_W}
                y={screen.height - screen.gutter - 64}
                width={SIDE_BUTTON_W}
                height={64}
                forwardFocus={0}
                onUp={() => (actionsRef?.setFocus(), true)}
                onLeft={() => (aboutRef?.setFocus(), true)}
              >
                <PillButton label={t("Debug")} width={SIDE_BUTTON_W} onSelect={() => navigate("/debug")} />
              </View>
            </Show>
            {/* Where titles and ratings come from, with each service's credit: everyone. */}
            <Show when={!editing()}>
              <View
                ref={el => (aboutRef = el)}
                x={screen.gutter}
                y={screen.height - screen.gutter - 64}
                width={SIDE_BUTTON_W}
                height={64}
                forwardFocus={0}
                onUp={() => (actionsRef?.setFocus(), true)}
                onRight={() => (data()?.admin && debugRef ? (debugRef.setFocus(), true) : false)}
              >
                <PillButton label={t("About")} width={SIDE_BUTTON_W} onSelect={() => navigate("/about")} />
              </View>
            </Show>
          </View>
        }
      >
        <PinEntry
          title={t("PIN for {name}", { name: displayText(pinFor()!.display_name || pinFor()!.username) })}
          error={error()}
          onSubmit={pin => void switchTo(pinFor()!, pin)}
          onCancel={() => setPinFor(null)}
        />
      </Show>
      {/* Add profile: the name being typed, above the keyboard sheet. */}
      <View
        width={screen.width}
        height={screen.height}
        color={color.background}
        alpha={adding() ? 1 : 0}
        skipFocus={!adding()}
        zIndex={20}
      >
        <Text x={screen.width / 2} mountX={0.5} y={160} fontSize={font.title} color={color.text} zIndex={21}>
          {t("Add a profile")}
        </Text>
        <View
          x={(screen.width - 900) / 2}
          y={290}
          width={900}
          height={88}
          borderRadius={theme.radius.md}
          color={theme.glass.regular}
          border={glassEdge(true)}
          zIndex={21}
        >
          <Text
            x={36}
            y={44 + font.heading * OPTICAL_Y}
            mountY={0.5}
            lineHeight={font.heading}
            fontSize={font.heading}
            color={newName() ? color.text : color.textMuted}
            zIndex={22}
          >
            {newName() ? `${displayText(newName())}_` : t("Name")}
          </Text>
        </View>
        <Text
          x={screen.width / 2}
          mountX={0.5}
          y={410}
          fontSize={font.caption}
          color={color.error}
          alpha={addError() ? 1 : 0}
          zIndex={21}
        >
          {addError() || " "}
        </Text>
      </View>
      <KeyboardSheet
        open={adding()}
        ref={el => (keyboardRef = el)}
        onType={ch => setNewName(n => (n + ch).slice(0, 32))}
        onDelete={() => setNewName(n => n.slice(0, -1))}
        onClear={() => setNewName("")}
        onClose={() => void finishAdding()}
        value={newName()}
        title={t("Name")}
      />
    </View>
  );
}
