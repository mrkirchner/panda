import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { api, ensureSession, pinMessage } from "../api/client";
import { currentUser } from "../api/session";
import { getServer } from "../api/server";
import { Avatar, AVATAR_ART } from "../components/Avatar";
import { PillButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PinEntry } from "../components/PinEntry";
import { FocusRing } from "../components/FocusRing";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { ROW_W, SettingRow } from "../components/SettingRow";
import { displayText } from "../format";
import { lang, t } from "../i18n";
import { theme } from "../theme";

const { screen, color, font } = theme;
const X = screen.gutter;
const BIG = 360;
/** The picture picker: posters from the library, in rows of this many (four rows fit). */
const PICKER_COLUMNS = 9;
const LIBRARY_ART_MAX = PICKER_COLUMNS * 4 - 1;
const BIG_X = screen.width - screen.gutter - 120 - BIG;
const LANGUAGES = [
  { id: "en", name: "English" },
  { id: "es", name: "Español" },
] as const;

/** The big avatar on the right: OK opens the picture picker. */
function AvatarButton(props: { name: string; picture: string | null | undefined; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View width={BIG} height={BIG + 70} onFocusChanged={setFocused} onEnter={() => (props.onSelect(), true)}>
      <View
        width={BIG}
        height={BIG}
        scale={focused() ? 1.05 : 1}
        transition={{ scale: { duration: theme.focus.duration } }}
      >
        <Avatar name={props.name} size={BIG} picture={props.picture} />
        <FocusRing
          width={BIG}
          height={BIG}
          radius={BIG / 2}
          ringWidth={theme.focus.ringWidthRound}
          visible={focused()}
        />
      </View>
      <Text
        x={BIG / 2}
        y={BIG + 40}
        mountX={0.5}
        fontSize={font.caption}
        color={focused() ? color.text : color.textMuted}
      >
        {t("Change picture")}
      </Text>
    </View>
  );
}

/** One picture in the picker. */
function Choice(props: { id: string; name: string; selected: boolean; onSelect: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const S = 150;
  return (
    <View
      width={S}
      height={S}
      scale={focused() ? 1.1 : 1}
      transition={{ scale: { duration: theme.focus.duration } }}
      onFocusChanged={setFocused}
      onEnter={() => (props.onSelect(), true)}
    >
      <Avatar name={props.name} size={S} picture={props.id || null} />
      <FocusRing
        width={S}
        height={S}
        radius={S / 2}
        ringWidth={theme.focus.ringWidthRound}
        visible={focused() || props.selected}
      />
    </View>
  );
}

type Panel = "main" | "avatar" | "language" | "pin" | "signin";
/** PIN steps: confirm the current PIN (to change or remove it), then choose a new one. */
type PinStep = { kind: "current"; then: "change" | "remove" } | { kind: "new"; current?: string };

/**
 * Edit profile (opened from "Who's watching?"): Name and Language rows on the left, the avatar
 * large on the right. The avatar and language each open their own page. Changes save at once
 * and follow the profile to every TV.
 */
export default function EditProfile() {
  const navigate = useNavigate();
  /** Edit profile is opened from Who's watching (in edit mode); always return there, still
   * editing (history may not lead back, e.g. after a reload), replacing this page so Back
   * doesn't reopen it. */
  const [params] = useSearchParams();
  // A just-added profile returns to the plain picker; editing one returns to edit mode.
  const leave = () => navigate(params.new === "1" ? "/profiles" : "/profiles?edit=1", { replace: true });
  const [confirming, setConfirming] = createSignal(false);
  const [hasPin, setHasPin] = createSignal(false);
  void api.pinStatus().then(
    r => setHasPin(r.has_pin),
    () => {},
  );
  const [pinStep, setPinStep] = createSignal<PinStep | null>(null);
  const [pinError, setPinError] = createSignal("");
  const startPin = (step: PinStep) => {
    setPinError("");
    setPinStep(step);
  };
  /** A PIN step finished: check/apply it on the server, then move on. */
  const submitPin = async (pin: string) => {
    const step = pinStep();
    if (!step) return;
    try {
      if (step.kind === "current" && step.then === "remove") {
        await api.setProfilePin(null, pin);
        setHasPin(false);
        setPinStep(null);
        setPanel("main");
      } else if (step.kind === "current") {
        // The server checks the current PIN together with the new one.
        startPin({ kind: "new", current: pin });
      } else {
        await api.setProfilePin(pin, step.current);
        setHasPin(true);
        setPinStep(null);
        setPanel("main");
      }
    } catch (e) {
      setPinError(pinMessage(e));
      // A wrong current PIN while choosing the new one: ask for the current one again.
      if (step.kind === "new" && step.current) setPinStep({ kind: "current", then: "change" });
    }
  };
  const [deleteError, setDeleteError] = createSignal("");
  const deleteProfile = () => api.deleteProfile().then(leave, (e: Error) => setDeleteError(e.message));
  void ensureSession().catch(() => {});
  const me = () => currentUser();
  const [panel, setPanel] = createSignal<Panel>("main");
  // Posters to pick a picture from: the best rated movies and shows (loaded with the picker).
  const [libraryArtRes] = createResource(
    () => panel() === "avatar" || undefined,
    async () => {
      const [movies, shows] = await Promise.all([api.titles().catch(() => []), api.series().catch(() => [])]);
      const all = [
        ...movies.map(m => ({ poster: m.poster, rating: m.rating ?? 0 })),
        ...shows.map(s => ({ poster: s.poster, rating: s.rating ?? 0 })),
      ];
      const keys = all
        .filter(x => x.poster)
        .sort((a, b) => b.rating - a.rating)
        .map(x => x.poster!);
      return [...new Set(keys)].slice(0, LIBRARY_ART_MAX);
    },
  );
  const libraryArt = () => libraryArtRes() ?? [];
  /** The picker's grid: the plain initial (no picture), then posters from the library. */
  const pickerRows = () => {
    const ids = ["", ...libraryArt().map(k => AVATAR_ART + k)];
    const rows: string[][] = [];
    for (let i = 0; i < ids.length; i += PICKER_COLUMNS) rows.push(ids.slice(i, i + PICKER_COLUMNS));
    return rows;
  };
  const [name, setName] = createSignal<string | null>(null);
  /** What the keyboard is typing into. */
  const [field, setField] = createSignal<"name" | "email" | null>(null);
  const typing = () => field() !== null;
  const [email, setEmail] = createSignal("");
  const [signInNote, setSignInNote] = createSignal("");
  let signInRef: ElementNode | undefined;
  const type = (f: (v: string) => string) =>
    field() === "email" ? setEmail(v => f(v).slice(0, 254)) : setName(n => f(n ?? "").slice(0, 32));
  const [error, setError] = createSignal("");
  let nameRef: ElementNode | undefined;
  let listRef: ElementNode | undefined;
  let avatarRef: ElementNode | undefined;
  const toAvatar = () => (avatarRef?.setFocus(), true);
  let keyboardRef: ElementNode | undefined;

  const shownName = () => name() ?? me()?.name ?? "";
  const save = (p: Parameters<typeof api.updateProfile>[0]) =>
    api.updateProfile(p).then(
      () => setError(""),
      (e: Error) => setError(e.message),
    );
  const openKeyboard = () => {
    setName(me()?.name ?? "");
    setField("name");
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  /** Sign-in: off, ask for their email (the link goes there); on, the option to turn it off. */
  const openSignIn = () => {
    if (me()?.canSignIn) return void setPanel("signin");
    setSignInNote("");
    setField("email");
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const sendLink = async () => {
    const to = email().trim();
    if (!to) return;
    try {
      const r = await api.signInLink(to);
      setSignInNote(
        r.sent
          ? t("Sent a link to {email} to choose a password.", { email: r.email })
          : t("Mail isn't set up on the server. Open this link to choose a password: {url}", {
              url: `${getServer() ?? ""}${r.path}`,
            }),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const closeKeyboard = () => {
    const was = field();
    setField(null);
    if (was === "email") {
      void sendLink();
      signInRef?.setFocus();
      return;
    }
    const n = name()?.trim();
    if (n && n !== me()?.name) void save({ display_name: n });
    setName(null);
    nameRef?.setFocus();
  };
  const back = () => {
    if (pinStep()) setPinStep(null);
    else if (confirming()) setConfirming(false);
    else if (typing()) closeKeyboard();
    else if (panel() !== "main") setPanel("main");
    else leave();
    return true;
  };
  useTypedInput({
    enabled: typing,
    hasText: () => Boolean(field() === "email" ? email() : name()),
    onType: ch => type(v => v + ch),
    onDelete: () => type(v => v.slice(0, -1)),
  });
  const languageName = () => LANGUAGES.find(l => l.id === (me()?.language ?? lang()))?.name ?? "English";

  return (
    <View onBack={back}>
      <Show when={panel() === "main" && !pinStep()}>
        <View>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("Edit profile")}
          </Text>
          {/* The keyboard covers the Sign-in row: what's typed shows here. */}
          <Text x={X} y={190} fontSize={font.body} color={color.text} alpha={field() === "email" ? 1 : 0}>
            {t("Their email: {email}", { email: displayText(email()) }) + "_"}
          </Text>
          {/* Settings on the left; Right goes to the profile column (avatar, Done, Delete). */}
          <Column
            ref={el => (listRef = el)}
            x={X}
            y={300}
            width={ROW_W}
            gap={theme.space.list}
            scroll="none"
            autofocus
            onRight={toAvatar}
          >
            <SettingRow
              ref={el => (nameRef = el)}
              label={t("Name")}
              value={shownName()}
              icon="chevron"
              onSelect={openKeyboard}
            />
            <SettingRow
              label={t("Language")}
              value={languageName()}
              icon="chevron"
              onSelect={() => setPanel("language")}
            />
            {/* Home preview clips play quietly; this profile can have them silent. */}
            <SettingRow
              label={t("Preview sound")}
              value={me()?.previewSound === false ? t("Off") : t("On")}
              icon="chevron"
              onSelect={() => void api.updateProfile({ preview_sound: me()?.previewSound === false })}
            />
            <SettingRow
              label={t("PIN")}
              value={hasPin() ? t("On") : t("Off")}
              icon="chevron"
              onSelect={() => (hasPin() ? setPanel("pin") : startPin({ kind: "new" }))}
            />
            {/* The account's owner: each profile's age limit, behind the parental PIN. */}
            <Show when={me()?.primary}>
              <SettingRow
                label={t("Parental controls")}
                icon="chevron"
                onSelect={() => navigate("/parental")}
              />
            </Show>
            {/* Their own sign-in (email + a password they choose); the owner always has one. */}
            <Show when={me() && !me()!.primary}>
              <SettingRow
                ref={el => (signInRef = el)}
                label={t("Sign-in")}
                value={
                  field() === "email" ? `${email()}_` : me()?.canSignIn ? (me()?.email ?? t("On")) : t("Off")
                }
                icon="chevron"
                onSelect={openSignIn}
              />
            </Show>
          </Column>
          {/* The profile itself on the right: its picture, then Done and Delete stacked under
              it at the avatar's width. Left goes back to the settings. */}
          <Column
            ref={el => (avatarRef = el)}
            x={BIG_X}
            y={230}
            width={BIG}
            gap={theme.space.item}
            scroll="none"
            onLeft={() => (listRef?.setFocus(), true)}
          >
            <AvatarButton
              name={shownName() || "?"}
              picture={me()?.avatar}
              onSelect={() => setPanel("avatar")}
            />
            <PillButton primary label={t("Done")} width={BIG} onSelect={leave} />
            {/* The account owner (primary profile) can't be deleted from a TV. */}
            <Show when={me() && !me()!.primary}>
              <PillButton
                danger
                label={t("Delete profile")}
                width={BIG}
                onSelect={() => {
                  setDeleteError("");
                  setConfirming(true);
                }}
              />
            </Show>
          </Column>
          <Show when={confirming()}>
            <ConfirmDialog
              title={t('Delete "{name}"?', { name: me()?.name ?? "" })}
              message={t("Their watch history, My List and requests are deleted too. This can't be undone.")}
              confirmLabel={t("Delete profile")}
              danger
              error={deleteError()}
              onConfirm={() => void deleteProfile()}
              onCancel={() => {
                setConfirming(false);
                avatarRef?.setFocus();
              }}
            />
          </Show>
        </View>
      </Show>

      {/* Picture picker: the colored initial first, then posters from the library. */}
      <Show when={panel() === "avatar"}>
        <View>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("Choose a picture")}
          </Text>
          <Column x={X} y={230} width={screen.width - X * 2} gap={theme.space.item} scroll="none" autofocus>
            <For each={pickerRows()}>
              {row => (
                <Row width={screen.width - X * 2} height={150} gap={theme.space.item} scroll="none">
                  <For each={row}>
                    {id => (
                      <Choice
                        id={id}
                        name={shownName() || "?"}
                        selected={(me()?.avatar ?? "") === id}
                        onSelect={() => {
                          void save({ avatar: id || null });
                          setPanel("main");
                        }}
                      />
                    )}
                  </For>
                </Row>
              )}
            </For>
          </Column>
        </View>
      </Show>

      {/* Language list. */}
      <Show when={panel() === "language"}>
        <View>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("Language")}
          </Text>
          <Column x={X} y={300} width={ROW_W} gap={theme.space.list} scroll="none" autofocus>
            <For each={LANGUAGES}>
              {l => (
                <SettingRow
                  label={l.name}
                  icon={(me()?.language ?? lang()) === l.id ? "check" : null}
                  onSelect={() => {
                    void save({ language: l.id });
                    setPanel("main");
                  }}
                />
              )}
            </For>
          </Column>
        </View>
      </Show>

      {/* PIN: change or remove an existing one. */}
      <Show when={panel() === "pin" && !pinStep()}>
        <View>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("PIN")}
          </Text>
          <Column x={X} y={300} width={ROW_W} gap={theme.space.list} scroll="none" autofocus>
            <SettingRow
              label={t("Change PIN")}
              icon="chevron"
              onSelect={() => startPin({ kind: "current", then: "change" })}
            />
            <SettingRow
              label={t("Remove PIN")}
              icon="chevron"
              onSelect={() => startPin({ kind: "current", then: "remove" })}
            />
          </Column>
        </View>
      </Show>
      <Show when={pinStep()} keyed>
        {step => (
          <View width={screen.width} height={screen.height} color={color.background} zIndex={20}>
            <PinEntry
              title={step.kind === "current" ? t("Enter the current PIN") : t("Choose a new PIN")}
              error={pinError()}
              onSubmit={pin => void submitPin(pin)}
              onCancel={() => setPinStep(null)}
            />
          </View>
        )}
      </Show>

      {/* Sign-in: on, the option to turn it off. */}
      <Show when={panel() === "signin"}>
        <View>
          <Text x={X} y={110} fontSize={font.title} color={color.text}>
            {t("Sign-in")}
          </Text>
          <Text x={X} y={200} fontSize={font.caption} color={color.textMuted}>
            {t("{name} signs in with {email}.", { name: me()?.name ?? "", email: me()?.email ?? "" })}
          </Text>
          <Column x={X} y={300} width={ROW_W} gap={theme.space.list} scroll="none" autofocus>
            <SettingRow
              label={t("Turn off sign-in")}
              icon="chevron"
              onSelect={() =>
                void api.turnOffSignIn().then(
                  () => setPanel("main"),
                  (e: Error) => setError(e.message),
                )
              }
            />
          </Column>
        </View>
      </Show>
      <Text
        x={X}
        y={screen.height - 120}
        width={screen.width - X * 2}
        contain="width"
        maxLines={2}
        fontSize={font.caption}
        color={color.text}
        alpha={signInNote() && panel() === "main" ? 1 : 0}
      >
        {displayText(signInNote()) || " "}
      </Text>
      <Text x={X} y={screen.height - 70} fontSize={20} color={color.error} alpha={error() ? 1 : 0}>
        {displayText(error()) || " "}
      </Text>

      <KeyboardSheet
        open={typing()}
        ref={el => (keyboardRef = el)}
        onType={ch => type(v => v + ch)}
        onDelete={() => type(v => v.slice(0, -1))}
        onClear={() => type(() => "")}
        onClose={closeKeyboard}
        value={field() === "email" ? email() : shownName()}
        title={field() === "email" ? t("Their email") : t("Name")}
        kind={field() === "email" ? "email" : "text"}
      />
    </View>
  );
}
