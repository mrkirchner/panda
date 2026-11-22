import { createSignal, onCleanup, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column, Row } from "@solidtv/solid/primitives";
import { api, ensureSession, HttpError, landingPath, resetSession } from "../api/client";
import { getServer } from "../api/server";
import { getDeviceSecret, setDeviceSecret, setToken } from "../api/session";
import { PillButton } from "../components/Button";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { FIELD_W, TextField } from "../components/TextField";
import { device } from "../device";
import { displayText } from "../format";
import { theme } from "../theme";
import { t } from "../i18n";

const { screen, color, font } = theme;
const FORM_X = (screen.width - FIELD_W) / 2;

type FieldName = "username" | "password";

/**
 * TV sign-in. Username and password, typed with the remote (or a keyboard): the TV gets its
 * own revocable device credential, no code to approve anywhere. "Use a code instead" shows a
 * short code to approve at `<server>/link` from a phone (handy for long passwords).
 */
export default function Link() {
  const navigate = useNavigate();
  // ?add=1: this TV is already paired; signing in adds a profile of its account.
  const [search] = useSearchParams<{ add?: string }>();
  const adding = () => search.add === "1" && !!getDeviceSecret();
  const [mode, setMode] = createSignal<"password" | "code">("password");

  // ---- username and password ----
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [editing, setEditing] = createSignal<FieldName | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let userRef: ElementNode | undefined;
  let passRef: ElementNode | undefined;
  let signInRef: ElementNode | undefined;
  let keyboardRef: ElementNode | undefined;
  const set = (f: (v: string) => string) =>
    editing() === "username" ? setUsername(v => f(v).slice(0, 64)) : setPassword(v => f(v).slice(0, 256));
  const edit = (field: FieldName) => {
    setError("");
    setEditing(field);
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const doneEditing = () => {
    const was = editing();
    setEditing(null);
    // Username done: on to the password; password done: on to Sign in.
    if (was === "username" && !password()) edit("password");
    else setTimeout(() => (was === "username" ? passRef : signInRef)?.setFocus(), 0);
  };
  useTypedInput({
    enabled: () => editing() !== null,
    hasText: () => (editing() === "username" ? username() : password()).length > 0,
    // Typed as is (passwords are case-sensitive; the keyboard's shift handles capitals).
    onType: ch => set(v => v + ch),
    onDelete: () => set(v => v.slice(0, -1)),
  });
  const signIn = async () => {
    if (busy()) return;
    if (!username().trim() || !password()) {
      setError(t("Enter your username and password."));
      return void edit(username().trim() ? "password" : "username");
    }
    setBusy(true);
    setError("");
    try {
      const d = await device;
      const res = await api.deviceLogin(
        username().trim(),
        password(),
        `Panda TV (${d.type.toLowerCase()})`,
        getDeviceSecret(),
      );
      setToken(res.token);
      if (res.device_token) setDeviceSecret(res.device_token);
      resetSession();
      await ensureSession();
      navigate(await landingPath(), { replace: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      setError(
        status === 401
          ? t("That username and password don't match.")
          : status === 429
            ? t("Too many tries. Wait a few minutes.")
            : status === 403
              ? t("This TV belongs to another account.")
              : t("Can't reach the Panda server at {url}. Retrying...", { url: getServer() ?? "" }),
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  // ---- link code (from a phone) ----
  const [code, setCode] = createSignal("");
  const [status, setStatus] = createSignal(t("Getting a code..."));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
  });
  const useCode = () => {
    setMode("code");
    void start();
  };
  const usePassword = () => {
    clearTimeout(timer);
    setMode("password");
    setTimeout(() => userRef?.setFocus(), 0);
  };

  async function start() {
    try {
      const d = await device;
      const start = await api.startDeviceSignIn(
        `Panda TV (${d.type.toLowerCase()})`,
        adding() ? getDeviceSecret() : undefined,
      );
      setCode(start.user_code);
      setStatus(
        `On your phone or computer, open ${getServer()}${start.verification_path} and enter this code.`,
      );
      poll(start.device_code, start.interval * 1000, Date.now() + start.expires_in * 1000);
    } catch (e) {
      // Rate limited (too many codes requested from this network): wait it out, don't hammer.
      if (e instanceof HttpError && e.status === 429) {
        const secs = Number(/(\d+) seconds/.exec(e.message)?.[1] ?? 60);
        setStatus(t("Too many sign-in attempts. Trying again in {min} min.", { min: Math.ceil(secs / 60) }));
        timer = setTimeout(start, (secs + 1) * 1000);
        return;
      }
      setStatus(t("Can't reach the Panda server at {url}. Retrying...", { url: getServer() ?? "" }));
      timer = setTimeout(start, 5000);
    }
  }

  function poll(deviceCode: string, interval: number, deadline: number) {
    timer = setTimeout(async () => {
      if (!alive) return;
      if (Date.now() > deadline) return void start();
      try {
        const res = await api.pollDevice(deviceCode);
        if (res.status === "approved") {
          setToken(res.token);
          if (res.device_token) setDeviceSecret(res.device_token);
          resetSession();
          await ensureSession();
          navigate(await landingPath(), { replace: true });
          return;
        }
        if (res.status === "expired") return void start();
      } catch {
        // Network blip: keep polling until the code expires.
      }
      poll(deviceCode, interval, deadline);
    }, interval);
  }

  return (
    <View
      onBack={() => (editing() ? (doneEditing(), true) : mode() === "code" ? (usePassword(), true) : false)}
    >
      <Text x={screen.width / 2} mountX={0.5} y={140} fontSize={font.title} color={color.text}>
        {adding() ? t("Add a profile to this TV") : t("Sign in to Panda")}
      </Text>
      <Text x={screen.width / 2} mountX={0.5} y={220} fontSize={font.caption} color={color.textMuted}>
        {displayText(getServer() ?? "") || " "}
      </Text>

      <Show when={mode() === "password"}>
        <Column x={FORM_X} y={320} width={FIELD_W} gap={theme.space.list} scroll="none" autofocus>
          <TextField
            ref={el => (userRef = el)}
            label={t("Username")}
            value={username()}
            placeholder={t("Your username")}
            active={editing() === "username"}
            onSelect={() => edit("username")}
          />
          <TextField
            ref={el => (passRef = el)}
            label={t("Password")}
            value={password()}
            placeholder={t("Your password")}
            secret
            active={editing() === "password"}
            onSelect={() => edit("password")}
          />
          <View width={FIELD_W} height={10} skipFocus />
          <Row width={FIELD_W} height={64} gap={theme.space.item} scroll="none">
            <View ref={el => (signInRef = el)} width={300} height={64} forwardFocus={0}>
              <PillButton
                primary
                label={busy() ? t("Signing in...") : t("Sign in")}
                width={300}
                onSelect={() => void signIn()}
              />
            </View>
            <PillButton label={t("Use a code instead")} width={360} onSelect={useCode} />
          </Row>
        </Column>
        <Text
          x={screen.width / 2}
          mountX={0.5}
          y={680}
          fontSize={font.caption}
          color={color.error}
          alpha={error() ? 1 : 0}
        >
          {error() || " "}
        </Text>
      </Show>

      <Show when={mode() === "code"}>
        <Text x={screen.width / 2} mountX={0.5} y={380} fontSize={140} color={color.text}>
          {code() || " "}
        </Text>
        <Text
          x={screen.width / 2}
          mountX={0.5}
          y={600}
          width={1400}
          contain="width"
          textAlign="center"
          maxLines={3}
          fontSize={font.body}
          color={color.textMuted}
        >
          {status()}
        </Text>
        <View x={(screen.width - 380) / 2} y={760} width={380} height={64} forwardFocus={0}>
          <PillButton label={t("Use a password instead")} width={380} onSelect={usePassword} autofocus />
        </View>
      </Show>

      <KeyboardSheet
        open={editing() !== null}
        ref={el => (keyboardRef = el)}
        onType={ch => set(v => v + ch)}
        onDelete={() => set(v => v.slice(0, -1))}
        onClear={() => set(() => "")}
        onClose={doneEditing}
        value={editing() === "password" ? password() : username()}
        title={editing() === "password" ? t("Password") : t("Username")}
        secure={editing() === "password"}
        kind="email"
      />
    </View>
  );
}
