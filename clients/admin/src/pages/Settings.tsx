import { createMemo, createSignal, For, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { api } from "../api/client";
import { formatBytes } from "../format";
import type {
  ArrProbe,
  ArrService,
  ArrSettings,
  BenchState,
  MailSecurity,
  MailSettings,
  MetadataField,
  MetadataOrder,
  MetadataProvider,
} from "../api/types";
import { AdminOnly } from "../components/Frame";
import { Card, ConfirmButton, Notice, useAction } from "../components/ui";

export default function Settings() {
  return (
    <AdminOnly>
      <SettingsInner />
    </AdminOnly>
  );
}

type Section = "metadata" | "requests" | "email" | "storage" | "performance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "metadata", label: "Metadata" },
  { id: "requests", label: "Requests" },
  { id: "email", label: "Email" },
  { id: "storage", label: "Storage" },
  { id: "performance", label: "Performance" },
];

function SettingsInner() {
  const settings = createMemo(() => api.settings());
  const [section, setSection] = createSignal<Section>("metadata");
  /** What a section's tab says: set up, needs setting up, or optional and not set up. */
  const status = (id: Section): { text: string; kind: "ok" | "warn" | "" } | null => {
    const s = settings();
    switch (id) {
      case "metadata":
        return s.tmdb.configured ? { text: "Ready", kind: "ok" } : { text: "Start here", kind: "warn" };
      case "requests":
        return s.radarr || s.radarr_4k || s.sonarr || s.sonarr_4k
          ? { text: "Connected", kind: "ok" }
          : { text: "Optional", kind: "" };
      case "email":
        return s.mail ? { text: "Set up", kind: "ok" } : { text: "Optional", kind: "" };
      case "storage":
      case "performance":
        return null;
    }
  };
  return (
    <>
      <h1>Settings</h1>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <Show when={!settings().tmdb.configured}>
          <Notice>
            <strong>Getting started:</strong> add a free TMDB token under Metadata. It's the only thing Panda
            needs for posters, plots and episode names. Everything else here is optional and can be added
            later.
          </Notice>
        </Show>
        <div class="tabs" role="tablist" aria-label="Settings sections">
          <For each={SECTIONS}>
            {(sec) => (
              <button
                type="button"
                class="tab"
                role="tab"
                id={`settings-tab-${sec.id}`}
                aria-controls={`settings-${sec.id}`}
                aria-selected={section() === sec.id ? "true" : "false"}
                data-active={section() === sec.id ? "" : undefined}
                onClick={() => setSection(sec.id)}
              >
                {sec.label}
                <Show when={status(sec.id)}>
                  {(st) => <span class={["badge", st().kind]}>{st().text}</span>}
                </Show>
              </button>
            )}
          </For>
        </div>

        <Panel id="metadata" shown={section()}>
          <p class="muted section-intro">
            Where titles, artwork and episode information come from. TMDB is required; the others add to it.
            Tokens and keys are encrypted on the server and never shown again after saving.
          </p>
          <Show when={settings().providers.find((p) => p.base)}>
            {(tmdb) => (
              <TmdbCard
                provider={tmdb()}
                configured={settings().tmdb.configured}
                source={settings().tmdb.source}
                onChange={() => refresh(settings)}
              />
            )}
          </Show>
          {/* Keyed by id: a refresh after a save brings new objects, and the cards (with their
              "Saved." and error messages) must survive it. */}
          <For each={settings().providers.filter((p) => !p.base)} keyed={(p) => p.id}>
            {(p) => <ProviderCard provider={p()} onChange={() => refresh(settings)} />}
          </For>
          <OrderCard
            order={settings().metadata_order}
            fields={settings().metadata_fields}
            providers={settings().providers}
            onChange={() => refresh(settings)}
          />
        </Panel>

        <Panel id="requests" shown={section()}>
          <p class="muted section-intro">
            Connect Radarr (movies) and Sonarr (shows) so people can request titles from the TV. Set up the HD
            servers first; the 4K ones are only for keeping a second, 4K copy. API keys are encrypted on the
            server and never shown again. Leave a key field empty to keep the saved one.
          </p>
          <ArrCard
            service="radarr"
            label="Radarr (movies)"
            current={settings().radarr}
            onChange={() => refresh(settings)}
          />
          <ArrCard
            service="sonarr"
            label="Sonarr (TV shows)"
            current={settings().sonarr}
            onChange={() => refresh(settings)}
          />
          <ArrCard
            service="radarr_4k"
            label="Radarr 4K (optional)"
            hint="A second Radarr that keeps 4K copies. Movie requests go to both."
            current={settings().radarr_4k}
            onChange={() => refresh(settings)}
          />
          <ArrCard
            service="sonarr_4k"
            label="Sonarr 4K (optional)"
            hint="A second Sonarr that keeps 4K copies. Show requests go to both."
            current={settings().sonarr_4k}
            onChange={() => refresh(settings)}
          />
          <BazarrCard current={settings().bazarr} onChange={() => refresh(settings)} />
          <CleanupCard
            current={settings().cleanup}
            hasRadarr={!!settings().radarr || !!settings().radarr_4k}
            hasSonarr={!!settings().sonarr || !!settings().sonarr_4k}
            onChange={() => refresh(settings)}
          />
        </Panel>

        <Panel id="email" shown={section()}>
          <p class="muted section-intro">
            Optional. With a mail server, invites and sign-in links are emailed; without one, Panda gives you
            the link to share yourself. The password is encrypted on the server; leave it empty to keep the
            saved one.
          </p>
          <MailCard current={settings().mail} onChange={() => refresh(settings)} />
        </Panel>

        <Panel id="storage" shown={section()}>
          <StorageCard />
        </Panel>

        <Panel id="performance" shown={section()}>
          <PerformanceCard />
        </Panel>
      </Loading>
    </>
  );
}

/** A Settings section. Every one stays mounted (hidden when not shown), so switching tabs
 * keeps what's typed in the others. */
function Panel(props: { id: Section; shown: Section; children: JSX.Element }) {
  return (
    <div
      id={`settings-${props.id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${props.id}`}
      hidden={props.shown !== props.id}
    >
      {props.children}
    </div>
  );
}

/**
 * Save a checkbox's new state with `action`. If the save fails, the box goes back to how it
 * was (the server never changed, so a refresh alone wouldn't move it back).
 */
function saveCheckbox(
  action: ReturnType<typeof useAction>,
  box: HTMLInputElement,
  save: (on: boolean) => Promise<unknown>,
  after: () => void,
) {
  const on = box.checked;
  void action
    .run(() => save(on))
    .then((ok) => {
      if (!ok) box.checked = !on;
      after();
    });
}

/** A secret (token or key) checked by the server before it's saved: status, form, Remove. */
function SecretKeyCard(props: {
  title: string;
  children?: JSX.Element;
  /** Below the form (a provider's "What to use" switches). */
  after?: JSX.Element;
  configured: boolean;
  /** "configured via PANDA_TMDB_TOKEN": set outside Panda, so there's no form. */
  fromEnv?: string;
  notConfigured: string;
  field: string;
  hint: string;
  /** Why the field can't be used yet ("Set up TMDB first"). */
  blockedBy?: string;
  saveLabel: string;
  savedText: string;
  removeConfirm: string;
  save: (value: string) => Promise<unknown>;
  remove: () => Promise<unknown>;
  onChange: () => void;
}) {
  const save = useAction();
  const [saved, setSaved] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    setSaved(false);
    if (await save.run(() => props.save(String(new FormData(form).get("secret"))))) {
      form.reset();
      setSaved(true);
      props.onChange();
    }
  };
  const remove = () => {
    setSaved(false);
    void save.run(props.remove).then(props.onChange);
  };
  return (
    <Card title={props.title}>
      {props.children}
      <p>
        Status:{" "}
        <Show when={props.configured} fallback={<span class="badge warn">{props.notConfigured}</span>}>
          <span class="badge ok">configured{props.fromEnv ? ` via ${props.fromEnv}` : ""}</span>
        </Show>
      </p>
      <Show when={!props.fromEnv}>
        <form class="stack" onSubmit={submit}>
          <label>
            {props.field}
            <span class="hint">{props.hint}</span>
            <input
              name="secret"
              type="password"
              autocomplete="off"
              required
              disabled={!!props.blockedBy}
              placeholder={props.blockedBy ?? (props.configured ? "(saved)" : "")}
            />
          </label>
          <Show when={save.error()}>
            <Notice kind="error">{save.error()}</Notice>
          </Show>
          <Show when={saved()}>
            <Notice kind="ok">{props.savedText}</Notice>
          </Show>
          <div class="row">
            <button class="primary" disabled={save.busy() || !!props.blockedBy}>
              {save.busy() ? "Checking..." : props.saveLabel}
            </button>
            <Show when={props.configured}>
              <ConfirmButton
                label="Remove"
                confirm={props.removeConfirm}
                disabled={save.busy()}
                onConfirm={remove}
              />
            </Show>
          </div>
        </form>
      </Show>
      {props.after}
    </Card>
  );
}

/** TMDB, the base: its token (or `$PANDA_TMDB_TOKEN`), with its credit and hint from the server. */
function TmdbCard(props: {
  provider: MetadataProvider;
  configured: boolean;
  source: string | null;
  onChange: () => void;
}) {
  return (
    <SecretKeyCard
      title="TMDB (posters, plots, episode names)"
      configured={props.configured}
      fromEnv={props.source === "env" ? "PANDA_TMDB_TOKEN" : undefined}
      notConfigured="not configured"
      field="API Read Access Token"
      hint={`${props.provider.key_hint ?? ""} It's checked with TMDB before saving.`}
      saveLabel="Save token"
      savedText="Saved. New items will be matched on the next scan."
      removeConfirm="Remove the TMDB token? Existing metadata is kept."
      save={api.saveTmdb}
      remove={api.removeTmdb}
      onChange={props.onChange}
    >
      <Credit provider={props.provider} />
    </SecretKeyCard>
  );
}

/** The credit a provider's terms ask for, linking to its site. */
function Credit(props: { provider: MetadataProvider }) {
  return (
    <p class="hint">
      {props.provider.credit}{" "}
      <a href={props.provider.site} target="_blank" rel="noreferrer">
        {props.provider.site.replace(/^https?:\/\/(www\.)?/, "")}
      </a>
    </p>
  );
}

/**
 * An extra metadata provider (TVmaze, OMDb, ...), drawn from what the server says about it:
 * a key form for one that needs a key, else an on/off switch; then its "What to use" switches.
 * They add to TMDB (found by the ids TMDB gives), so setting one up needs TMDB.
 */
function ProviderCard(props: { provider: MetadataProvider; onChange: () => void }) {
  const save = useAction();
  return (
    <Show
      when={props.provider.key_hint}
      fallback={
        <Card title={props.provider.name}>
          <p class="muted">{props.provider.about}</p>
          <Credit provider={props.provider} />
          <label class="check">
            <input
              type="checkbox"
              checked={props.provider.enabled}
              // Turning it on needs TMDB; turning it off never does.
              disabled={(!!props.provider.blocked_by && !props.provider.enabled) || save.busy()}
              onChange={(e) =>
                saveCheckbox(
                  save,
                  e.currentTarget,
                  (on) => api.saveProvider(props.provider.id, { enabled: on }),
                  props.onChange,
                )
              }
            />
            Use {props.provider.name}
            {props.provider.blocked_by ? `: ${props.provider.blocked_by}` : ""}
          </label>
          <ProviderSwitches provider={props.provider} onChange={props.onChange} />
          <Show when={save.error()}>
            <Notice kind="error">{save.error()}</Notice>
          </Show>
        </Card>
      }
    >
      {(hint) => (
        <SecretKeyCard
          title={props.provider.name}
          configured={props.provider.enabled}
          notConfigured="not set up"
          field="API key"
          hint={`${hint()} It's checked with ${props.provider.name} before saving.`}
          blockedBy={props.provider.blocked_by ?? undefined}
          saveLabel="Save key"
          savedText="Saved. Titles are being looked up now and after each scan."
          removeConfirm={`Remove the ${props.provider.name} key? What it added stops showing (it's kept if you add a key again).`}
          save={(key) => api.saveProvider(props.provider.id, { api_key: key })}
          remove={() => api.removeProvider(props.provider.id)}
          onChange={props.onChange}
          after={<ProviderSwitches provider={props.provider} onChange={props.onChange} />}
        >
          <p class="muted">{props.provider.about}</p>
          <Credit provider={props.provider} />
        </SecretKeyCard>
      )}
    </Show>
  );
}

/** "What to use: IMDb rating, Rotten Tomatoes score, ...": what a provider adds, each on or off. */
function ProviderSwitches(props: { provider: MetadataProvider | undefined; onChange: () => void }) {
  const save = useAction();
  const active = () => !!props.provider?.enabled;
  return (
    <Show when={props.provider?.options.length}>
      <fieldset class="switches" disabled={!active() || save.busy()}>
        <legend>What to use{active() ? "" : " (once it's on)"}</legend>
        <For each={props.provider!.options}>
          {(o) => (
            <label class="check">
              <input
                type="checkbox"
                checked={o.on}
                onChange={(e) =>
                  saveCheckbox(
                    save,
                    e.currentTarget,
                    (on) => api.saveProviderSwitch(props.provider!.id, o.id, on),
                    props.onChange,
                  )
                }
              />
              {o.label}
            </label>
          )}
        </For>
      </fieldset>
      <Show when={save.error()}>
        <Notice kind="error">{save.error()}</Notice>
      </Show>
    </Show>
  );
}

/** Which provider's answer is shown, per kind of data: a short reorderable list each. */
function OrderCard(props: {
  order: MetadataOrder;
  fields: { id: MetadataField; label: string }[];
  providers: MetadataProvider[];
  onChange: () => void;
}) {
  const save = useAction();
  const provider = (id: string) => props.providers.find((p) => p.id === id);
  const move = (field: MetadataField, from: number, to: number) => {
    const list = [...props.order[field]];
    const [p] = list.splice(from, 1);
    list.splice(to, 0, p);
    void save.run(() => api.saveMetadataOrder({ ...props.order, [field]: list })).then(props.onChange);
  };
  return (
    <Card title="Which source is shown">
      <p class="muted">
        When sources disagree, the first one in each list that has a real answer wins; the next fills its
        gaps. Changes apply right away, with nothing looked up again. Sources that are off are skipped.
        Ratings aren't ordered: every source that's on is shown.
      </p>
      <div class="stack">
        <For each={props.fields}>
          {(field) => (
            <div>
              <strong>{field.label}</strong>
              <ol class="order-list">
                <For each={props.order[field.id]}>
                  {(id, i) => (
                    <li>
                      <span>{provider(id)?.name ?? id}</span>
                      <Show when={!provider(id)?.enabled}>
                        <span class="badge">off</span>
                      </Show>
                      <span class="order-actions">
                        <button
                          type="button"
                          aria-label={`Move ${provider(id)?.name ?? id} up`}
                          disabled={i() === 0 || save.busy()}
                          onClick={() => move(field.id, i(), i() - 1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${provider(id)?.name ?? id} down`}
                          disabled={i() === props.order[field.id].length - 1 || save.busy()}
                          onClick={() => move(field.id, i(), i() + 1)}
                        >
                          ↓
                        </button>
                      </span>
                    </li>
                  )}
                </For>
              </ol>
            </div>
          )}
        </For>
      </div>
      <Show when={save.error()}>
        <Notice kind="error">{save.error()}</Notice>
      </Show>
    </Card>
  );
}

function ArrCard(props: {
  service: ArrService;
  label: string;
  /** Extra line under the title (what this server is for). */
  hint?: string;
  current: ArrSettings | null;
  onChange: () => void;
}) {
  // Writable derived signal: follows the saved URL until the user edits it (Solid 2 forbids
  // reading props at the top of a component body, since they may still be loading).
  const [url, setUrl] = createSignal(() => props.current?.url ?? "");
  const [key, setKey] = createSignal("");
  const [probe, setProbe] = createSignal<ArrProbe | null>(null);
  const [saved, setSaved] = createSignal(false);
  const test = useAction();
  const save = useAction();
  const movies = () => props.service.startsWith("radarr");

  /** The server's root folders with free space, plus the saved one if the server dropped it. */
  const folderOptions = (p: ArrProbe) => {
    const list = p.root_folders.map((r) => ({
      path: r.path,
      label: r.free_space ? `${r.path}  (${formatBytes(r.free_space)} free)` : r.path,
    }));
    const saved = props.current?.root_folder;
    if (saved && !list.some((r) => r.path === saved))
      list.push({ path: saved, label: `${saved}  (not on the server)` });
    return list;
  };

  const runProbe = () => test.run(async () => setProbe(await api.probeArr(props.service, url(), key())));

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    setSaved(false);
    const ok = await save.run(() =>
      api.saveArr(props.service, {
        url: url(),
        api_key: key(),
        quality_profile_id: Number(f.get("profile")),
        root_folder: String(f.get("root")),
      }),
    );
    if (ok) {
      setKey("");
      setSaved(true);
      props.onChange();
    }
  };

  return (
    <Card title={props.label}>
      <Show when={props.hint}>
        <p class="muted">{props.hint}</p>
      </Show>
      <p>
        Status:{" "}
        <Show when={props.current} fallback={<span class="badge">not connected</span>}>
          {(c) => (
            <span class="badge ok">
              connected to {c().url} ({c().root_folder})
            </span>
          )}
        </Show>
      </p>
      <form class="stack" onSubmit={submit}>
        <div class="row">
          <label style={{ flex: "2" }}>
            URL
            <input
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              required
              placeholder={movies() ? "http://nas.local:7878" : "http://nas.local:8989"}
            />
          </label>
          <label style={{ flex: "2" }}>
            API key
            <span class="hint">Settings, then General, in {movies() ? "Radarr" : "Sonarr"}.</span>
            <input
              type="password"
              autocomplete="off"
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
              placeholder={props.current?.api_key_set ? "(saved)" : ""}
              required={!props.current?.api_key_set}
            />
          </label>
        </div>
        <div>
          <button type="button" disabled={test.busy() || !url()} onClick={runProbe}>
            {test.busy() ? "Connecting..." : "Test connection"}
          </button>
        </div>
        <Show when={test.error()}>
          <Notice kind="error">{test.error()}</Notice>
        </Show>
        <Show when={probe()}>
          {(p) => (
            <>
              <Notice kind="ok">Connected (version {p().version}).</Notice>
              <div class="row">
                <label style={{ flex: "1" }}>
                  Quality profile for requests
                  <select name="profile">
                    <For each={p().quality_profiles}>
                      {(q) => (
                        <option value={q.id} selected={q.id === props.current?.quality_profile_id}>
                          {q.name}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label style={{ flex: "1" }}>
                  Root folder
                  <span class="hint">
                    {movies() ? "Radarr" : "Sonarr"}'s root folders (its Settings, then Media Management). Add
                    a folder there to pick it here.
                  </span>
                  <select name="root">
                    <For each={folderOptions(p())}>
                      {(r) => (
                        <option value={r.path} selected={r.path === props.current?.root_folder}>
                          {r.label}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
              </div>
              <Show when={save.error()}>
                <Notice kind="error">{save.error()}</Notice>
              </Show>
              <div class="row">
                <button class="primary" disabled={save.busy()}>
                  {save.busy() ? "Saving..." : "Save"}
                </button>
              </div>
            </>
          )}
        </Show>
        <Show when={saved()}>
          <Notice kind="ok">Saved.</Notice>
        </Show>
        <Show when={props.current}>
          <div>
            <ConfirmButton
              label="Disconnect"
              confirm={`Disconnect ${props.label}? Requests will stop working.`}
              onConfirm={() => save.run(() => api.removeArr(props.service)).then(props.onChange)}
            />
          </div>
        </Show>
      </form>
    </Card>
  );
}

/** Outgoing mail: lets Panda email sign-in links to profiles. */
function MailCard(props: { current: MailSettings | null; onChange: () => void }) {
  const save = useAction();
  const test = useAction();
  const [saved, setSaved] = createSignal(false);
  const [tested, setTested] = createSignal(false);
  const c = () => props.current;
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    setSaved(false);
    const ok = await save.run(() =>
      api.saveMail({
        host: String(f.get("host")),
        port: Number(f.get("port")),
        security: String(f.get("security")) as MailSecurity,
        username: String(f.get("username") ?? ""),
        password: String(f.get("password") ?? ""),
        from: String(f.get("from")),
      }),
    );
    if (ok) {
      setSaved(true);
      props.onChange();
    }
  };
  const sendTest = async (e: SubmitEvent) => {
    e.preventDefault();
    setTested(false);
    if (
      await test.run(() => api.testMail(String(new FormData(e.currentTarget as HTMLFormElement).get("to"))))
    ) {
      setTested(true);
    }
  };
  return (
    <Card title="Email (mail server)">
      <p class="muted">
        Lets Panda email sign-in links: when someone gets their own sign-in for a profile, they receive a link
        to choose their password. Use your email provider's SMTP settings (for Gmail, an app password).
      </p>
      <p>
        Status:{" "}
        <Show when={c()} fallback={<span class="badge warn">not set up</span>}>
          {(m) => <span class="badge ok">sending through {m().host}</span>}
        </Show>
      </p>
      <form class="stack" onSubmit={submit}>
        <div class="row">
          <label style={{ flex: "2" }}>
            Server
            <input name="host" required placeholder="smtp.example.com" value={c()?.host ?? ""} />
          </label>
          <label style={{ flex: "1" }}>
            Port
            <input name="port" type="number" required min="1" max="65535" value={c()?.port ?? 587} />
          </label>
          <label style={{ flex: "1" }}>
            Security
            <select name="security">
              <option value="starttls" selected={(c()?.security ?? "starttls") === "starttls"}>
                STARTTLS (587)
              </option>
              <option value="tls" selected={c()?.security === "tls"}>
                TLS (465)
              </option>
              <option value="none" selected={c()?.security === "none"}>
                None (local relay)
              </option>
            </select>
          </label>
        </div>
        <div class="row">
          <label style={{ flex: "1" }}>
            Username
            <input name="username" autocomplete="off" value={c()?.username ?? ""} />
          </label>
          <label style={{ flex: "1" }}>
            Password
            <input
              name="password"
              type="password"
              autocomplete="off"
              placeholder={c()?.password_set ? "(saved)" : ""}
            />
          </label>
        </div>
        <label>
          From
          <span class="hint">The sender people see, e.g. Panda &lt;panda@example.com&gt;.</span>
          <input name="from" required placeholder="Panda <panda@example.com>" value={c()?.from ?? ""} />
        </label>
        <Show when={save.error()}>
          <Notice kind="error">{save.error()}</Notice>
        </Show>
        <Show when={saved()}>
          <Notice kind="ok">Saved: Panda connected and signed in to the mail server.</Notice>
        </Show>
        <div class="row">
          <button class="primary" disabled={save.busy()}>
            {save.busy() ? "Connecting..." : "Save"}
          </button>
          <Show when={c()}>
            <ConfirmButton
              label="Remove"
              confirm="Remove the mail settings? Sign-in links will have to be shared by hand."
              onConfirm={() => save.run(() => api.removeMail()).then(props.onChange)}
            />
          </Show>
        </div>
      </form>
      <Show when={c()}>
        <form class="row" onSubmit={sendTest} style={{ "margin-top": "1rem" }}>
          <label style={{ flex: "1" }}>
            Send a test email to
            <input name="to" type="email" required placeholder="you@example.com" />
          </label>
          <button disabled={test.busy()} style={{ "align-self": "flex-end" }}>
            {test.busy() ? "Sending..." : "Send test"}
          </button>
        </form>
        <Show when={test.error()}>
          <Notice kind="error">{test.error()}</Notice>
        </Show>
        <Show when={tested()}>
          <Notice kind="ok">Sent. Check the inbox (and spam).</Notice>
        </Show>
      </Show>
    </Card>
  );
}

/** Bazarr: lets the TV ask for subtitles in the viewer's language when a title has none. */
function BazarrCard(props: { current: { url: string; api_key_set: boolean } | null; onChange: () => void }) {
  const save = useAction();
  const [version, setVersion] = createSignal<string | null>(null);
  const c = () => props.current;
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    setVersion(null);
    let v: string | null = null;
    const ok = await save.run(async () => {
      v = (await api.saveBazarr(String(f.get("url")), String(f.get("api_key") ?? ""))).version;
    });
    if (ok) {
      setVersion(v);
      props.onChange();
    }
  };
  return (
    <Card title="Bazarr (optional)">
      <p class="muted">
        Lets the TV find subtitles on request: when a title has none in the viewer's language (and isn't in
        it), the Subtitles menu offers to look, and Bazarr downloads them. Bazarr knows one Radarr; a movie's
        versions share their subtitle files, so one copy is enough. The API key is in Bazarr under Settings
        &gt; General.
      </p>
      <p>
        Status:{" "}
        <Show when={c()} fallback={<span class="badge warn">not set up</span>}>
          {(b) => <span class="badge ok">connected to {b().url}</span>}
        </Show>
      </p>
      <form class="stack" onSubmit={submit}>
        <div class="row">
          <label style={{ flex: "2" }}>
            Address
            <input name="url" required placeholder="http://192.168.1.10:6767" value={c()?.url ?? ""} />
          </label>
          <label style={{ flex: "1" }}>
            API key
            <input
              name="api_key"
              type="password"
              autocomplete="off"
              placeholder={c()?.api_key_set ? "(saved)" : ""}
            />
          </label>
        </div>
        <Show when={save.error()}>
          <Notice kind="error">{save.error()}</Notice>
        </Show>
        <Show when={version()}>
          <Notice kind="ok">Saved: connected to Bazarr {version()}.</Notice>
        </Show>
        <div class="row">
          <button class="primary" disabled={save.busy()}>
            {save.busy() ? "Connecting..." : "Save"}
          </button>
          <Show when={c()}>
            <ConfirmButton
              label="Remove"
              confirm="Remove Bazarr? The TV stops offering to find subtitles."
              onConfirm={() => save.run(() => api.removeBazarr()).then(props.onChange)}
            />
          </Show>
        </div>
      </form>
    </Card>
  );
}

/** Weekly: titles Panda requested that are finished come off Radarr/Sonarr's lists. */
function CleanupCard(props: {
  current: { movies: boolean; shows: boolean };
  hasRadarr: boolean;
  hasSonarr: boolean;
  onChange: () => void;
}) {
  const save = useAction();
  const run = useAction();
  const [ran, setRan] = createSignal<number | null>(null);
  const toggle = (kind: "movies" | "shows", box: HTMLInputElement) =>
    saveCheckbox(save, box, (on) => api.saveCleanup({ ...props.current, [kind]: on }), props.onChange);
  return (
    <Card title="Clean up Radarr and Sonarr">
      <p class="muted">
        Once a week, titles requested through Panda that are finished come off Radarr's and Sonarr's lists.
        Files are never deleted, and titles you added there yourself are left alone. Finished means: in your
        library for a week and not waiting for a better quality; for shows, also ended (no more episodes
        coming) with every requested episode downloaded. Requesting one again adds it back.
      </p>
      <div class="stack">
        <label class="check">
          <input
            type="checkbox"
            checked={props.current.movies}
            disabled={!props.hasRadarr || save.busy()}
            onChange={(e) => toggle("movies", e.currentTarget)}
          />
          Movies (Radarr){props.hasRadarr ? "" : ": not connected"}
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={props.current.shows}
            disabled={!props.hasSonarr || save.busy()}
            onChange={(e) => toggle("shows", e.currentTarget)}
          />
          Shows (Sonarr){props.hasSonarr ? "" : ": not connected"}
        </label>
      </div>
      <Show when={save.error() ?? run.error()}>
        <Notice kind="error">{save.error() ?? run.error()}</Notice>
      </Show>
      <Show when={ran() !== null}>
        <Notice kind="ok">
          {ran() === 1 ? "Removed 1 finished title." : `Removed ${ran()} finished titles.`}
        </Notice>
      </Show>
      <Show when={props.current.movies || props.current.shows}>
        <div class="row">
          <button
            disabled={run.busy()}
            onClick={() =>
              void run.run(async () => {
                setRan((await api.runCleanup()).removed);
              })
            }
          >
            {run.busy() ? "Cleaning up..." : "Run now"}
          </button>
        </div>
      </Show>
    </Card>
  );
}

/** Where Panda keeps things, and the cache's ceiling. */
/** The stream capacity test: run it, watch it, and apply the re-encode limit it suggests. */
function PerformanceCard() {
  const [state, setState] = createSignal<BenchState | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const start = useAction();
  const apply = useAction();
  const [applied, setApplied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = async () => {
    clearTimeout(timer);
    try {
      const s = await api.bench();
      setState(s);
      setLoadError(null);
      // While it runs: its lines as they come.
      if (s.progress.running) timer = setTimeout(load, 2000);
    } catch (e) {
      setLoadError(String(e));
    }
  };
  void load();
  onCleanup(() => clearTimeout(timer));
  const run = async () => {
    setApplied(false);
    if (await start.run(() => api.startBench())) void load();
  };
  const useSuggested = async (n: number) => {
    setApplied(false);
    if (await apply.run(() => api.saveHardwareLimit(n))) {
      setApplied(true);
      void load();
    }
  };
  const when = (secs: number) => new Date(secs * 1000).toLocaleString();
  return (
    <Card title="Streams this server can handle">
      <p class="muted">
        Plays files from your libraries the way streaming does, 1, 2, 3... at once, until a stream can't keep
        up (each must run at least {state()?.min_speed ?? 1.1}x real time). Takes a few minutes and keeps the
        server busy meanwhile, so it only runs when nothing is playing.
      </p>
      <Show when={loadError()}>
        <Notice kind="error">{loadError()}</Notice>
      </Show>
      <div class="row">
        <button
          class="primary"
          disabled={start.busy() || !!state()?.progress.running}
          onClick={() => void run()}
        >
          {state()?.progress.running ? "Testing..." : state()?.report ? "Run again" : "Run the test"}
        </button>
      </div>
      <Show when={start.error()}>
        <Notice kind="error">{start.error()}</Notice>
      </Show>
      <Show when={state()?.progress.error}>
        <Notice kind="error">The test stopped: {state()?.progress.error}</Notice>
      </Show>
      <Show when={state()?.progress.running || (state()?.progress.lines.length && !state()?.report)}>
        <pre class="log">{state()?.progress.lines.join("\n") || "Starting..."}</pre>
      </Show>
      <Show when={state()?.report}>
        {(r) => (
          <>
            <table>
              <thead>
                <tr>
                  <th>Kind of stream</th>
                  <th>At once</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                <For each={r().kinds}>
                  {(k) => (
                    <tr>
                      <td>{k.name}</td>
                      <td>
                        <strong>{k.best === k.max ? `${k.best}+` : k.best}</strong>
                      </td>
                      <td class="muted">{k.how}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <p class="muted">
              Tested {when(r().ran_at)} with ffmpeg {r().ffmpeg.version}. Hardware:{" "}
              {r().ffmpeg.hardware.join(", ") || "none (software only)"}. HDR to SDR:{" "}
              {r().ffmpeg.tonemap.join(", ") || "not available"}.
            </p>
          </>
        )}
      </Show>
      <p>
        Hardware re-encodes at once: <strong>{state()?.hardware_limit ?? "?"}</strong>
        <Show when={state()?.suggested_hardware_limit}>
          {(n) => (
            <Show
              when={n() !== state()?.hardware_limit}
              fallback={<span class="muted"> (as the test suggests)</span>}
            >
              {" "}
              <span class="muted">(the test suggests {n()})</span>{" "}
              <button disabled={apply.busy()} onClick={() => void useSuggested(n())}>
                Use {n()}
              </button>
            </Show>
          )}
        </Show>
      </p>
      <Show when={apply.error()}>
        <Notice kind="error">{apply.error()}</Notice>
      </Show>
      <Show when={applied()}>
        <Notice kind="ok">Applied: new streams follow it now.</Notice>
      </Show>
    </Card>
  );
}

function StorageCard() {
  const storage = createMemo(() => api.storage());
  const save = useAction();
  const [saved, setSaved] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setSaved(false);
    const gb = Number(new FormData(e.currentTarget as HTMLFormElement).get("gb"));
    if (await save.run(() => api.saveStorage(gb))) {
      setSaved(true);
      refresh(storage);
    }
  };
  return (
    <Card title="Storage">
      <Loading fallback={<p class="muted">Measuring...</p>}>
        <p>
          Data (back this up): <code>{storage().data_dir}</code>
          <br />
          Cache (safe to delete, rebuilt as needed): <code>{storage().cache_dir}</code>
        </p>
        <p class="muted">
          Previews and subtitles use {formatBytes(storage().cache_used_bytes)}; artwork uses{" "}
          {formatBytes(storage().images_bytes)} (artwork is never trimmed).
        </p>
        <form class="row" onSubmit={submit}>
          <label>
            Cache limit (GB)
            <span class="hint">
              The oldest previews and subtitles go first, checked hourly. 0 = no limit.
            </span>
            <input name="gb" type="number" min="0" step="1" required value={storage().cache_max_gb ?? 0} />
          </label>
          <button
            class="primary"
            disabled={save.busy()}
            style={{ "align-self": "flex-start", "margin-top": "1.6rem" }}
          >
            Save
          </button>
        </form>
        <Show when={save.error()}>
          <Notice kind="error">{save.error()}</Notice>
        </Show>
        <Show when={saved()}>
          <Notice kind="ok">Saved.</Notice>
        </Show>
      </Loading>
    </Card>
  );
}
