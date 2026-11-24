// Edit profile, as on the TV (../tv/src/pages/EditProfile.tsx), for the profile signed in (Who's
// watching signs in as a profile before editing it, PIN first): its picture (a bundled one, a
// poster from the library, or its initial), name, language, preview sound (clips quiet or
// silent), PIN, its own sign-in (a link to choose a password), and Delete (not the owner's).
import { api, ensureSession, imageUrl, pinMessage } from "@tv/api/client";
import { getServer } from "@tv/api/server";
import { currentUser } from "@tv/api/session";
import { t } from "@tv/i18n";
import { For, Show, createSignal, onSettled } from "solid-js";
import { AVATARS, ART, Avatar } from "../components/Avatar";
import { ask, confirmAction, pick } from "../components/ui";
import { message } from "../data";
import { go, paths } from "../nav";

/** Posters offered as pictures: the best rated (the TV's count). */
const LIBRARY_ART_MAX = 60;

export default function EditProfile() {
  const [error, setError] = createSignal("");
  const [note, setNote] = createSignal("");
  const [hasPin, setHasPin] = createSignal(false);
  const [name, setName] = createSignal(() => currentUser()?.name ?? "");
  const [art, setArt] = createSignal<string[]>([]);
  const [showArt, setShowArt] = createSignal(false);
  const me = () => currentUser();

  onSettled(() => {
    void ensureSession().catch(() => {});
    api.pinStatus().then(
      (r) => setHasPin(r.has_pin),
      () => {},
    );
  });

  const save = (p: Parameters<typeof api.updateProfile>[0]) =>
    api.updateProfile(p).then(
      () => setError(""),
      (e: unknown) => setError(message(e)),
    );
  const saveName = () => {
    const n = name().trim().slice(0, 32);
    if (n && n !== me()?.name) void save({ display_name: n });
  };
  /** Read where they're shown, so "Same as this browser" follows a language change. */
  const langs = () => [
    { label: t("Same as this browser"), value: null as string | null },
    { label: "English", value: "en" },
    { label: "Español", value: "es" },
  ];
  const language = async (e: MouseEvent) => {
    const i = await pick(
      t("Language"),
      langs().map((l) => ({ label: l.label, selected: (me()?.language ?? null) === l.value })),
      e.currentTarget as Element,
    );
    if (i >= 0) void save({ language: langs()[i].value });
  };
  const loadArt = () => {
    setShowArt(true);
    if (art().length) return;
    void Promise.all([api.titles().catch(() => []), api.series().catch(() => [])]).then(([movies, shows]) => {
      const all = [
        ...movies.map((m) => ({ poster: m.poster, rating: m.rating ?? 0 })),
        ...shows.map((s) => ({ poster: s.poster, rating: s.rating ?? 0 })),
      ];
      const keys = all
        .filter((x) => x.poster)
        .sort((a, b) => b.rating - a.rating)
        .map((x) => x.poster!);
      setArt([...new Set(keys)].slice(0, LIBRARY_ART_MAX));
    });
  };

  /** Four digits; null if cancelled, "" if it wasn't four digits. */
  const askPin = async (title: string) => {
    const r = await ask(title, { input: { type: "pin" } });
    return r === null ? null : /^\d{4}$/.test(r) ? r : "";
  };
  const pin = async (e: MouseEvent) => {
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
      const choice = await pick(
        t("PIN"),
        [{ label: t("Change PIN") }, { label: t("Remove PIN") }],
        e.currentTarget as Element,
      );
      if (choice < 0) return;
      const current = await askPin(t("Enter the current PIN"));
      if (!current) return;
      if (choice === 1) {
        await api.setProfilePin(null, current);
        setHasPin(false);
      } else {
        const next = await askPin(t("Choose a new PIN"));
        if (!next) return;
        await api.setProfilePin(next, current);
      }
      setError("");
    } catch (err) {
      setError(pinMessage(err));
    }
  };
  /** Their own sign-in: a link to choose a password, emailed (or shown when mail isn't set up). */
  const signIn = async () => {
    if (me()?.canSignIn) {
      const off = await confirmAction(
        t("Sign-in"),
        t("{name} signs in with {email}.", { name: me()?.name ?? "", email: me()?.email ?? "" }),
        t("Turn off sign-in"),
        true,
      );
      if (off) await api.turnOffSignIn().catch((e: unknown) => setError(message(e)));
      return;
    }
    const to = (await ask(t("Their email"), { input: { type: "email" }, ok: t("Send") }))?.trim();
    if (!to) return;
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
      setError(message(e));
    }
  };
  const remove = async () => {
    const ok = await confirmAction(
      t("Delete profile"),
      t("Their watch history, My List and requests are deleted too. This can't be undone."),
      t("Delete profile"),
      true,
    );
    if (!ok) return;
    api.deleteProfile().then(
      () => go(paths.profiles, { replace: true }),
      (e: unknown) => setError(message(e)),
    );
  };

  return (
    <div class="form-page page-top">
      <h1>{t("Edit profile")}</h1>
      <Show when={me()}>
        {(m) => (
          <>
            <div class="form-section">
              <div class="setting-row start">
                <Avatar name={m().name} picture={m().avatar} size={96} />
                <div class="grow">
                  <label class="field flush">
                    <span>{t("Name")}</span>
                    <input
                      class="input"
                      maxlength={32}
                      value={name()}
                      onInput={(e) => setName(e.currentTarget.value)}
                      onChange={saveName}
                    />
                  </label>
                </div>
              </div>
            </div>
            <div class="form-section">
              <h2>{t("Choose a picture")}</h2>
              <div class="avatar-grid">
                <button
                  class={["avatar-choice", { on: !m().avatar }]}
                  aria-label={t("No picture")}
                  onClick={() => void save({ avatar: null })}
                >
                  <Avatar name={m().name} picture={null} size={64} />
                </button>
                <For each={AVATARS}>
                  {(a) => (
                    <button
                      class={["avatar-choice", { on: m().avatar === a }]}
                      aria-label={a}
                      onClick={() => void save({ avatar: a })}
                    >
                      <Avatar name={m().name} picture={a} size={64} />
                    </button>
                  )}
                </For>
              </div>
              <div class="after-grid">
                <Show
                  when={showArt()}
                  fallback={
                    <button class="btn small" onClick={loadArt}>
                      {t("From your library")}
                    </button>
                  }
                >
                  <h2>{t("From your library")}</h2>
                  <div class="avatar-grid">
                    <For each={art()}>
                      {(key) => (
                        <button
                          class={["avatar-choice", { on: m().avatar === `${ART}${key}` }]}
                          onClick={() => void save({ avatar: `${ART}${key}` })}
                        >
                          <span class="avatar" style={{ width: "100%", height: "100%" }}>
                            <img class="avatar-img art" src={imageUrl(key)} alt="" loading="lazy" />
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
            <div class="form-section setting-row">
              <div>
                <b>{t("Language")}</b>
              </div>
              <button class="chip" onClick={(e) => void language(e)}>
                {langs().find((l) => l.value === (m().language ?? null))?.label}
              </button>
            </div>
            <div class="form-section setting-row">
              <div>
                <b>{t("Preview sound")}</b>
                <div class="hint">{t("Previews on Home play quietly, or silent.")}</div>
              </div>
              <button
                class={["toggle", { on: m().previewSound !== false }]}
                role="switch"
                aria-checked={m().previewSound !== false ? "true" : "false"}
                aria-label={t("Preview sound")}
                onClick={() => void save({ preview_sound: m().previewSound === false })}
              />
            </div>
            <div class="form-section setting-row">
              <div>
                <b>{t("PIN")}</b>
                <div class="hint">{hasPin() ? t("On") : t("Off")}</div>
              </div>
              <button class="btn small" onClick={(e) => void pin(e)}>
                {hasPin() ? t("Change") : t("Set PIN")}
              </button>
            </div>
            {/* The owner always signs in with their own account (the TV hides this for them too). */}
            <Show when={!m().primary}>
              <div class="form-section setting-row">
                <div>
                  <b>{t("Sign-in")}</b>
                  <div class="hint">{m().canSignIn ? (m().email ?? t("On")) : t("Off")}</div>
                </div>
                <button class="btn small" onClick={() => void signIn()}>
                  {m().canSignIn ? t("Turn off sign-in") : t("Set up")}
                </button>
              </div>
            </Show>
            <Show when={note()}>
              <p class="hint breakable">{note()}</p>
            </Show>
            <Show when={error()}>
              <p class="error">{error()}</p>
            </Show>
            <div class="actions form-end">
              <button class="btn primary" onClick={() => go("/")}>
                {t("Done")}
              </button>
              <Show when={!m().primary}>
                <button class="btn danger" onClick={() => void remove()}>
                  {t("Delete profile")}
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
