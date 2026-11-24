import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { Column } from "@solidtv/solid/primitives";
import { api, pinMessage } from "../api/client";
import { ageLimitLabel, type AgeLimits } from "../api/types";
import { KeyboardSheet, useTypedInput } from "../components/Keyboard";
import { PinEntry } from "../components/PinEntry";
import { ROW_W, SettingRow } from "../components/SettingRow";
import { displayText } from "../format";
import { t } from "../i18n";
import { theme } from "../theme";

const { screen, color, font } = theme;
const X = screen.gutter;

/** What's on screen: the owner's password (first time), a PIN pad, the profiles, or one's limits. */
type Step =
  | { kind: "password" }
  | { kind: "new-pin"; password?: string; current?: string }
  | { kind: "pin" }
  | { kind: "list" }
  | { kind: "limit"; userId: number };

/**
 * Parental controls (the account's owner, from Edit profile): each profile's age limit. The
 * account's parental PIN is set once with the owner's password and asked when this page opens;
 * after that it's only asked to leave a limited profile (Who's watching).
 */
export default function ParentalControls() {
  const navigate = useNavigate();
  const [data, { refetch }] = createResource(() => api.ageLimits());
  const [step, setStep] = createSignal<Step | null>(null);
  const [error, setError] = createSignal("");
  /** The parental PIN, once checked: changes are sent with it. */
  let pin = "";
  const [password, setPassword] = createSignal("");
  let keyboardRef: ElementNode | undefined;

  /** The first step once the list is known: set a PIN up, or ask for it. */
  const current = (): Step => {
    const s = step();
    if (s) return s;
    return data()?.has_parental_pin ? { kind: "pin" } : { kind: "password" };
  };
  const go = (s: Step) => {
    setError("");
    setStep(s);
    if (s.kind === "password") setTimeout(() => keyboardRef?.setFocus(), 0);
  };
  const leave = () => navigate("/profile/edit", { replace: true });

  const checkPin = async (entered: string) => {
    try {
      await api.checkParentalPin(entered);
      pin = entered;
      go({ kind: "list" });
    } catch (e) {
      setError(pinMessage(e));
    }
  };
  const choosePin = async (entered: string, s: Extract<Step, { kind: "new-pin" }>) => {
    try {
      await api.setParentalPin(entered, { password: s.password, pin: s.current });
      pin = entered;
      await refetch();
      go({ kind: "list" });
    } catch (e) {
      // A wrong password: type it again.
      setError(pinMessage(e));
      if (s.password) go({ kind: "password" });
    }
  };
  const setLimit = async (userId: number, maxAge: number | null) => {
    try {
      await api.setAgeLimit(userId, maxAge, pin);
      await refetch();
      go({ kind: "list" });
    } catch (e) {
      setError(pinMessage(e));
    }
  };

  useTypedInput({
    enabled: () => current().kind === "password",
    hasText: () => Boolean(password()),
    onType: ch => setPassword(v => v + ch),
    onDelete: () => setPassword(v => v.slice(0, -1)),
  });
  const profile = (id: number) => data()?.profiles.find(p => p.user_id === id);
  const options = (d: AgeLimits) => [...d.limits, null] as (number | null)[];

  return (
    <View
      onBack={() => {
        const s = current();
        if (s.kind === "limit") go({ kind: "list" });
        else leave();
        return true;
      }}
    >
      <Show when={data()}>
        {d => (
          <>
            <Text x={X} y={110} fontSize={font.title} color={color.text}>
              {t("Parental controls")}
            </Text>
            <Text
              x={X}
              y={200}
              width={screen.width - X * 2}
              contain="width"
              maxLines={2}
              fontSize={font.caption}
              color={color.textMuted}
            >
              {current().kind === "password"
                ? t(
                    "Type your password to choose a parental PIN. It's asked to change age limits and to leave a profile that has one.",
                  )
                : t(
                    "A profile with an age limit only sees titles rated for that age. Leaving it needs the parental PIN.",
                  )}
            </Text>

            {/* The profiles and their limits. */}
            <Show when={current().kind === "list"}>
              <Column x={X} y={300} width={ROW_W} gap={theme.space.list} scroll="auto" autofocus>
                <For each={d().profiles}>
                  {p => (
                    <SettingRow
                      label={displayText(p.name)}
                      value={ageLimitLabel(p.max_age, t)}
                      icon="chevron"
                      onSelect={() => go({ kind: "limit", userId: p.user_id })}
                    />
                  )}
                </For>
                <SettingRow
                  label={t("Change parental PIN")}
                  icon="chevron"
                  onSelect={() => go({ kind: "new-pin", current: pin })}
                />
              </Column>
            </Show>

            {/* One profile's limit. */}
            <Show
              when={(() => {
                const s = current();
                return s.kind === "limit" ? s : null;
              })()}
              keyed
            >
              {s => (
                <View>
                  <Text x={X} y={250} fontSize={font.body} color={color.text}>
                    {displayText(profile(s.userId)?.name ?? "")}
                  </Text>
                  <Column x={X} y={320} width={ROW_W} gap={theme.space.list} scroll="auto" autofocus>
                    <For each={options(d())}>
                      {age => (
                        <SettingRow
                          label={ageLimitLabel(age, t)}
                          icon={profile(s.userId)?.max_age === age ? "check" : null}
                          onSelect={() => void setLimit(s.userId, age)}
                        />
                      )}
                    </For>
                  </Column>
                </View>
              )}
            </Show>

            {/* The owner's password (setting the PIN up), typed on the keyboard sheet. */}
            <Show when={current().kind === "password"}>
              <Text x={X} y={300} fontSize={font.body} color={color.text}>
                {t("Password: {dots}", { dots: "•".repeat(password().length) }) + "_"}
              </Text>
            </Show>
            <KeyboardSheet
              open={current().kind === "password"}
              ref={el => (keyboardRef = el)}
              onType={ch => setPassword(v => v + ch)}
              onDelete={() => setPassword(v => v.slice(0, -1))}
              onClear={() => setPassword("")}
              onClose={() => (password() ? go({ kind: "new-pin", password: password() }) : leave())}
              value={password()}
              title={t("Your password")}
              secure
            />

            {/* PIN pads: the current parental PIN, or a new one. */}
            <Show when={current().kind === "pin" || current().kind === "new-pin"}>
              <View width={screen.width} height={screen.height} color={color.background} zIndex={20}>
                <PinEntry
                  title={current().kind === "pin" ? t("Parental PIN") : t("Choose a parental PIN")}
                  error={error()}
                  onSubmit={entered => {
                    const s = current();
                    if (s.kind === "new-pin") void choosePin(entered, s);
                    else void checkPin(entered);
                  }}
                  onCancel={() => (current().kind === "new-pin" && pin ? go({ kind: "list" }) : leave())}
                />
              </View>
            </Show>
            <Text x={X} y={screen.height - 70} fontSize={20} color={color.error} alpha={error() ? 1 : 0}>
              {displayText(error()) || " "}
            </Text>
          </>
        )}
      </Show>
    </View>
  );
}
