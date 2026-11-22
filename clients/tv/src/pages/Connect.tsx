import { createSignal, For, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { getServer, normalizeServer, setServer } from "../api/server";
import { findServers, type FoundServer } from "../api/discover";
import { resetSession } from "../api/client";
import { getDeviceSecret, getToken } from "../api/session";
import { PillButton } from "../components/Button";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { FIELD_W, TextField } from "../components/TextField";
import { displayText } from "../format";
import { theme } from "../theme";
import { t } from "../i18n";

const { screen, color, font } = theme;
const FORM_X = (screen.width - FIELD_W) / 2;
const BUTTON_W = 300;
/** What an address can contain: host names, IPs, a port, a scheme. */
const ADDRESS_CHAR = /^[a-z0-9.:\-/]$/i;

/**
 * First run on a packaged TV app: Panda servers found on the home network are offered first
 * (src/api/discover.ts: Bonjour/NSD, or a scan of the TV's network), else the address is
 * entered with the remote (or a keyboard), laid out like sign-in: a centered field, the
 * keyboard sheet, Connect. Either way the address is checked before it's saved.
 */
export default function Connect() {
  const navigate = useNavigate();
  const [value, setValue] = createSignal(getServer()?.replace(/^https?:\/\//, "") ?? "");
  const [editing, setEditing] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  /** Servers found on the network, and whether it's still looking. */
  const [found, setFound] = createSignal<FoundServer[]>([]);
  const [searching, setSearching] = createSignal(true);
  let fieldRef: ElementNode | undefined;
  let formRef: ElementNode | undefined;
  let connectRef: ElementNode | undefined;
  let keyboardRef: ElementNode | undefined;

  const set = (f: (v: string) => string) => {
    setStatus("");
    setValue(v => f(v).slice(0, 80));
  };
  const type = (ch: string) => {
    if (ADDRESS_CHAR.test(ch)) set(v => v + ch.toLowerCase());
  };
  const edit = () => {
    setEditing(true);
    setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const doneEditing = () => {
    setEditing(false);
    setTimeout(() => (value().trim() ? connectRef : fieldRef)?.setFocus(), 0);
  };
  useTypedInput({
    enabled: editing,
    hasText: () => value().length > 0,
    onType: type,
    onDelete: () => set(v => v.slice(0, -1)),
  });
  // Look on the network first; nothing found and nothing entered yet: straight to typing.
  onMount(() => {
    void findServers()
      .catch(() => [] as FoundServer[])
      .then(list => {
        setFound(list);
        setSearching(false);
        if (!list.length && !value() && !editing()) edit();
        // Found one: focus starts on it (one press connects), unless typing already started.
        else if (list.length && !editing())
          setTimeout(() => (formRef?.children[0] as ElementNode | undefined)?.setFocus(), 0);
      });
  });
  const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/:8096$/, "");

  /** Connect to the typed address, or to `chosen` (a server found on the network). */
  async function connect(chosen?: string) {
    if (busy()) return;
    if (!chosen && !value().trim()) return edit();
    let url: string;
    try {
      url = chosen ?? normalizeServer(value());
    } catch {
      setFailed(true);
      return setStatus(t("That doesn't look like an address."));
    }
    setBusy(true);
    setFailed(false);
    setStatus(t("Checking {url}...", { url }));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${url}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok || (await res.text()).trim() !== "ok") throw new Error("not a Panda server");
      setServer(url);
      resetSession();
      // Signed in already (changing servers keeps nothing else): Home; else sign in.
      navigate(getToken() ? "/" : getDeviceSecret() ? "/profiles" : "/link", { replace: true });
    } catch {
      setFailed(true);
      setStatus(t("Can't reach a Panda server at {url}. Check the address and that it's on.", { url }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      onBack={() => {
        if (!editing()) return false;
        doneEditing();
        return true;
      }}
    >
      <Text x={screen.width / 2} mountX={0.5} y={140} fontSize={font.title} color={color.text}>
        {t("Connect to Panda")}
      </Text>
      <Text
        x={screen.width / 2}
        mountX={0.5}
        y={220}
        width={1200}
        contain="width"
        textAlign="center"
        fontSize={font.caption}
        color={color.textMuted}
      >
        {searching()
          ? t("Looking for Panda on your network...")
          : found().length
            ? t("Choose your Panda server, or enter its address.")
            : t("Enter your Panda server's address, e.g. 192.168.1.20")}
      </Text>

      <Column
        ref={el => (formRef = el)}
        x={FORM_X}
        y={320}
        width={FIELD_W}
        gap={theme.space.list}
        scroll="none"
        autofocus
      >
        {/* Found on the network: one press to connect. */}
        <For each={found()}>
          {s => (
            <PillButton
              primary
              label={`${displayText(s.name)} · ${hostOf(s.url)}`}
              width={FIELD_W}
              onSelect={() => void connect(s.url)}
            />
          )}
        </For>
        <Show when={found().length > 0}>
          <View width={FIELD_W} height={theme.space.block} skipFocus />
        </Show>
        <TextField
          ref={el => (fieldRef = el)}
          label={t("Server")}
          value={value()}
          placeholder="192.168.1.20"
          active={editing()}
          onSelect={edit}
        />
        <View
          ref={el => (connectRef = el)}
          x={(FIELD_W - BUTTON_W) / 2}
          width={BUTTON_W}
          height={64}
          forwardFocus={0}
        >
          <PillButton
            primary
            label={busy() ? t("Checking...") : t("Connect")}
            width={BUTTON_W}
            onSelect={() => void connect()}
          />
        </View>
      </Column>
      <Text
        x={screen.width / 2}
        mountX={0.5}
        // Below the form, which grows by a row per server found (and a gap after them).
        y={
          560 +
          found().length * (64 + theme.space.list) +
          (found().length ? theme.space.block + theme.space.list : 0)
        }
        width={1400}
        contain="width"
        textAlign="center"
        maxLines={2}
        fontSize={font.caption}
        color={failed() ? color.error : color.textMuted}
        alpha={status() ? 1 : 0}
      >
        {displayText(status()) || " "}
      </Text>

      <KeyboardSheet
        open={editing()}
        ref={el => (keyboardRef = el)}
        onType={type}
        onDelete={() => set(v => v.slice(0, -1))}
        onClear={() => set(() => "")}
        onClose={doneEditing}
        value={value()}
        title={t("Server address, e.g. 192.168.1.20")}
        kind="url"
      />
    </View>
  );
}
