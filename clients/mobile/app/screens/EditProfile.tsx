// Edit profile, as on the TV (../tv/src/pages/EditProfile.tsx), for the profile signed in (Who's
// watching signs in as a profile before editing it, PIN first): its picture (its initial, or a
// poster from the library), name, language, preview sound (clips quiet or silent), PIN, its own
// sign-in, and Delete (not the owner's).
import { Dialogs } from "@nativescript/core";
import { api, ensureSession, imageUrl } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { currentUser } from "@tv/api/session";
import { t } from "@tv/i18n";
import { For, Show, createSignal } from "solid-js";
import { Avatar } from "../avatar";
import { back, open } from "../nav";
import { goProfiles } from "../session";

/** Posters offered as pictures: the best rated (the TV's count). */
const LIBRARY_ART_MAX = 60;

function Row(props: { label: string; value: string; onTap: () => void; danger?: boolean }) {
  return (
    <gridlayout class="row" columns="*, auto" on:tap={props.onTap}>
      <label col={0} class={props.danger ? "error setting-label" : "body setting-label"} text={props.label} />
      <label col={1} class="muted" text={props.value} />
    </gridlayout>
  );
}

const pinMessage = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("Too many") ? t("Too many tries. Wait a few minutes.") : m.includes("wrong") ? t("Wrong PIN") : m;
};

/** `done`: where Done goes (Who's watching, or back to where it was opened from Home). */
export function editProfileScreen(done: () => void = goProfiles) {
  const [error, setError] = createSignal("");
  const [hasPin, setHasPin] = createSignal(false);
  const [note, setNote] = createSignal("");
  void ensureSession().catch(() => {});
  api.pinStatus().then(
    r => setHasPin(r.has_pin),
    () => {},
  );
  const me = () => currentUser();

  const save = (p: Parameters<typeof api.updateProfile>[0]) =>
    api.updateProfile(p).then(
      () => setError(""),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );

  const rename = async () => {
    const r = await Dialogs.prompt({
      title: t("Name"),
      defaultText: me()?.name ?? "",
      okButtonText: t("OK"),
      cancelButtonText: t("Cancel"),
    });
    const name = r.text?.trim().slice(0, 32);
    if (r.result && name && name !== me()?.name) void save({ display_name: name });
  };

  const LANGS = [
    { label: t("Same as this phone"), value: null },
    { label: "English", value: "en" },
    { label: "Español", value: "es" },
  ];
  const language = async () => {
    const pick = await Dialogs.action({
      title: t("Language"),
      cancelButtonText: t("Cancel"),
      actions: LANGS.map(l => l.label),
    });
    const l = LANGS.find(x => x.label === pick);
    if (l) void save({ language: l.value });
  };

  /** Four digits, asked natively; null if cancelled. */
  const askPin = async (title: string) => {
    const r = await Dialogs.prompt({
      title,
      okButtonText: t("OK"),
      cancelButtonText: t("Cancel"),
      inputType: "number",
    });
    return r.result && /^\d{4}$/.test(r.text ?? "") ? r.text! : r.result ? "" : null;
  };
  const pin = async () => {
    try {
      if (!hasPin()) {
        const p = await askPin(t("Choose a new PIN"));
        if (p === null) return;
        if (!p) return void setError(t("A PIN is four digits."));
        await api.setProfilePin(p);
        setHasPin(true);
        setError("");
        return;
      }
      const choice = await Dialogs.action({
        title: t("PIN"),
        cancelButtonText: t("Cancel"),
        actions: [t("Change PIN"), t("Remove PIN")],
      });
      if (choice !== t("Change PIN") && choice !== t("Remove PIN")) return;
      const current = await askPin(t("Enter the current PIN"));
      if (!current) return;
      if (choice === t("Remove PIN")) {
        await api.setProfilePin(null, current);
        setHasPin(false);
      } else {
        const next = await askPin(t("Choose a new PIN"));
        if (!next) return;
        await api.setProfilePin(next, current);
      }
      setError("");
    } catch (e) {
      setError(pinMessage(e));
    }
  };

  /** Their own sign-in: a link to choose a password, emailed (or shown when mail isn't set up). */
  const signIn = async () => {
    if (me()?.canSignIn) {
      const off = await Dialogs.confirm({
        title: t("Sign-in"),
        message: t("{name} signs in with {email}.", { name: me()?.name ?? "", email: me()?.email ?? "" }),
        okButtonText: t("Turn off sign-in"),
        cancelButtonText: t("Cancel"),
      });
      if (off) await api.turnOffSignIn().catch((e: unknown) => setError(String(e)));
      return;
    }
    const r = await Dialogs.prompt({
      title: t("Their email"),
      okButtonText: t("Send"),
      cancelButtonText: t("Cancel"),
      inputType: "email",
    });
    const to = r.text?.trim();
    if (!r.result || !to) return;
    try {
      const link = await api.signInLink(to);
      setNote(
        link.sent
          ? t("Sent a link to {email} to choose a password.", { email: link.email })
          : t("Mail isn't set up on the server. Open this link to choose a password: {url}", {
              url: `${getServer() ?? ""}${link.path}`,
            }),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    const ok = await Dialogs.confirm({
      title: t("Delete profile"),
      message: t("Their watch history, My List and requests are deleted too. This can't be undone."),
      okButtonText: t("Delete profile"),
      cancelButtonText: t("Cancel"),
    });
    if (!ok) return;
    api.deleteProfile().then(goProfiles, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <scrollview>
      <stacklayout class="form">
        <Show when={me()}>
          <stacklayout class="profile-head" on:tap={() => open(() => pictureScreen(), { title: t("Choose a picture") })}>
            <Avatar name={me()!.name} picture={me()!.avatar} size={110} />
            <label class="link center mt10" text={t("Change picture")} />
          </stacklayout>
          <Row label={t("Name")} value={me()!.name} onTap={() => void rename()} />
          <Row
            label={t("Language")}
            value={LANGS.find(l => l.value === (me()!.language ?? null))?.label ?? ""}
            onTap={() => void language()}
          />
          <Row
            label={t("Preview sound")}
            value={me()!.previewSound === false ? t("Off") : t("On")}
            onTap={() => void save({ preview_sound: me()!.previewSound === false })}
          />
          <Row label={t("PIN")} value={hasPin() ? t("On") : t("Off")} onTap={() => void pin()} />
          {/* The owner always signs in with their own account (the TV hides this for them too). */}
          <Show when={!me()!.primary}>
            <Row
              label={t("Sign-in")}
              value={me()!.canSignIn ? (me()!.email ?? t("On")) : t("Off")}
              onTap={() => void signIn()}
            />
          </Show>
          <Show when={note()}>
            <label class="muted mt10" textWrap={true} text={note()} />
          </Show>
          <Show when={error()}>
            <label class="error mt10" textWrap={true} text={error()} />
          </Show>
          <button class="primary" text={t("Done")} on:tap={done} />
          <Show when={!me()!.primary}>
            <button class="secondary danger" text={t("Delete profile")} on:tap={() => void remove()} />
          </Show>
        </Show>
      </stacklayout>
    </scrollview>
  );
}

/** The picture: the initial (none), or a poster from the library, cropped to the circle. */
function pictureScreen() {
  const [art, setArt] = createSignal<string[]>([]);
  Promise.all([api.titles().catch(() => []), api.series().catch(() => [])]).then(([movies, shows]) => {
    const all = [
      ...movies.map(m => ({ poster: m.poster, rating: m.rating ?? 0 })),
      ...shows.map(s => ({ poster: s.poster, rating: s.rating ?? 0 })),
    ];
    const keys = all
      .filter(x => x.poster)
      .sort((a, b) => b.rating - a.rating)
      .map(x => x.poster!);
    setArt([...new Set(keys)].slice(0, LIBRARY_ART_MAX));
  });
  const pick = (avatar: string | null) =>
    api.updateProfile({ avatar }).then(
      () => back(),
      (e: unknown) => void Dialogs.alert(e instanceof Error ? e.message : String(e)),
    );
  const me = () => currentUser();
  return (
    <scrollview>
      <stacklayout class="grid-page">
        <label class="muted" text={t("From your library")} />
        <wraplayout class="mt10">
          <stacklayout class="pick-cell" on:tap={() => void pick(null)}>
            <Avatar name={me()?.name ?? "?"} picture={null} size={88} />
          </stacklayout>
          <For each={art()}>
            {key => (
              <stacklayout class="pick-cell" on:tap={() => void pick(`art:${key}`)}>
                <image loadMode="async" class="pick-art" src={imageUrl(key)} stretch="aspectFill" />
              </stacklayout>
            )}
          </For>
        </wraplayout>
      </stacklayout>
    </scrollview>
  );
}
