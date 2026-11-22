import { createMemo, createSignal, For, Loading, refresh, Show } from "solid-js";
import { api } from "../api/client";
import type { LibraryRow } from "../api/types";
import { FolderPicker } from "../components/FolderPicker";
import { AdminOnly } from "../components/Frame";
import { Card, ConfirmButton, Notice, useAction } from "../components/ui";

export default function Libraries() {
  return (
    <AdminOnly>
      <LibrariesInner />
    </AdminOnly>
  );
}

const kindLabel = (k: LibraryRow["kind"]) => (k === "movies" ? "Movies" : "TV shows");

function ago(unix: number | null): string {
  if (!unix) return "not yet";
  const mins = Math.round((Date.now() / 1000 - unix) / 60);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

/** Folder path input with a server-side folder browser. */
function FolderInput(props: { name: string; value: string; onInput: (v: string) => void }) {
  const [browsing, setBrowsing] = createSignal(false);
  return (
    <div class="stack">
      <div class="row">
        <input
          name={props.name}
          required
          class="mono"
          style={{ flex: "1" }}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          placeholder="/Volumes/Media/Movies"
        />
        <button type="button" onClick={() => setBrowsing(!browsing())}>
          {browsing() ? "Close" : "Browse..."}
        </button>
      </div>
      <Show when={browsing()}>
        <FolderPicker
          onPick={(p) => {
            props.onInput(p);
            setBrowsing(false);
          }}
        />
      </Show>
    </div>
  );
}

/** One library: rename, its folders, merge another library in, remove. */
function LibraryCard(props: { lib: LibraryRow; others: LibraryRow[]; onChanged: () => void }) {
  const [name, setName] = createSignal(() => props.lib.name);
  const [folder, setFolder] = createSignal("");
  const [mergeFrom, setMergeFrom] = createSignal("");
  const act = useAction();
  const run = async (fn: () => Promise<unknown>) => {
    if (await act.run(fn)) props.onChanged();
  };

  return (
    <Card>
      <div class="row" style={{ "justify-content": "space-between" }}>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.renameLibrary(props.lib.id, name()));
          }}
        >
          <input
            aria-label="Library name"
            maxlength="64"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            style={{ "font-size": "1.2rem", "font-weight": "600" }}
          />
          <Show when={name().trim() !== props.lib.name}>
            <button class="primary" disabled={act.busy()}>
              Rename
            </button>
          </Show>
        </form>
        <span class="muted">
          {kindLabel(props.lib.kind)} | {props.lib.items} {props.lib.items === 1 ? "item" : "items"}
          {props.lib.unmatched ? ` | ${props.lib.unmatched} without metadata` : ""}
        </span>
      </div>

      <h3>Folders</h3>
      <ul class="stack" style={{ "list-style": "none", padding: "0" }}>
        <For each={props.lib.folders}>
          {(f) => (
            <li class="row" style={{ "justify-content": "space-between" }}>
              <span class="mono">{f}</span>
              <Show when={props.lib.folders.length > 1}>
                <ConfirmButton
                  label="Remove folder"
                  confirm={`Stop including ${f} in "${props.lib.name}"? Files on disk are not touched.`}
                  onConfirm={() => void run(() => api.removeFolder(props.lib.id, f))}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.addFolder(props.lib.id, folder());
            setFolder("");
          });
        }}
      >
        <label>
          Add a folder
          <span class="hint">
            Its files join this library. A movie found in several folders (e.g. 4K and HD) shows once, with a
            choice of version.
          </span>
          <FolderInput name="folder" value={folder()} onInput={setFolder} />
        </label>
        <div>
          <button disabled={act.busy() || !folder()}>Add folder and scan</button>
        </div>
      </form>

      <Show when={props.others.length > 0}>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            const from = Number(mergeFrom());
            const other = props.others.find((o) => o.id === from);
            if (!other) return;
            if (!window.confirm(`Move "${other.name}" (its folders and items) into "${props.lib.name}"?`))
              return;
            void run(() => api.mergeLibrary(props.lib.id, from));
          }}
        >
          <select value={mergeFrom()} onChange={(e) => setMergeFrom(e.currentTarget.value)}>
            <option value="">Merge another library into this one...</option>
            <For each={props.others}>{(o) => <option value={String(o.id)}>{o.name}</option>}</For>
          </select>
          <button disabled={act.busy() || !mergeFrom()}>Merge</button>
        </form>
      </Show>

      <Show when={act.error()}>
        <Notice kind="error">{act.error()}</Notice>
      </Show>
      <div>
        <ConfirmButton
          label="Remove library"
          confirm={`Remove "${props.lib.name}" from Panda? Files on disk are not touched.`}
          onConfirm={() => void run(() => api.removeLibrary(props.lib.id))}
        />
      </div>
    </Card>
  );
}

function LibrariesInner() {
  const libraries = createMemo(() => api.adminLibraries());
  const status = createMemo(() => api.scanStatus());
  const [path, setPath] = createSignal("");
  const add = useAction();
  const scan = useAction();
  const changed = () => {
    refresh(libraries);
    refresh(status);
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    const ok = await add.run(() =>
      api.addLibrary(String(f.get("name")), f.get("kind") as "movies" | "shows", path()),
    );
    if (ok) {
      form.reset();
      setPath("");
      changed();
    }
  };

  return (
    <>
      <h1>Libraries</h1>
      <p class="muted">
        Each library is a category on the TV (like Movies, 4K Movies or Kids) and can include several folders.
      </p>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <div class="row">
          <span class="muted">
            {status().scanning ? "Scanning now..." : `Last scan ${ago(status().last_scan_at)}.`}{" "}
            {status().interval_minutes
              ? `New files are picked up every ${status().interval_minutes} minutes, or right away from Sonarr/Radarr.`
              : "Periodic scans are off."}
          </span>
          <button
            disabled={scan.busy()}
            onClick={() => void scan.run(api.scan).then(() => setTimeout(changed, 1500))}
          >
            Scan now
          </button>
        </div>
        <For each={libraries()} fallback={<p class="muted">No libraries yet. Add one below.</p>}>
          {(l) => (
            <LibraryCard
              lib={l}
              others={libraries().filter((o) => o.id !== l.id && o.kind === l.kind)}
              onChanged={changed}
            />
          )}
        </For>
      </Loading>

      <Card title="Add a library">
        <form class="stack" onSubmit={submit}>
          <div class="row">
            <label style={{ flex: "1" }}>
              Name
              <input name="name" required maxlength="64" placeholder="Movies" />
            </label>
            <label>
              Type
              <select name="kind">
                <option value="movies">Movies</option>
                <option value="shows">TV shows</option>
              </select>
            </label>
          </div>
          <label>
            First folder on the server
            <span class="hint">Panda only reads this folder. It never modifies or deletes media.</span>
            <FolderInput name="path" value={path()} onInput={setPath} />
          </label>
          <Show when={add.error()}>
            <Notice kind="error">{add.error()}</Notice>
          </Show>
          <div>
            <button class="primary" disabled={add.busy()}>
              {add.busy() ? "Adding..." : "Add library and scan"}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
