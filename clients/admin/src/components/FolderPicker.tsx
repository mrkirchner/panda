import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { api } from "../api/client";

/** Browse folders on the *server* (admin-only API) to pick a library path. */
export function FolderPicker(props: { onPick: (path: string) => void }) {
  const [path, setPath] = createSignal<string | undefined>(undefined);
  const listing = createMemo(() => api.browse(path()));
  return (
    <div class="stack">
      <Loading fallback={<p class="muted">Loading folders...</p>}>
        <div class="row">
          <strong class="mono">{listing().path ?? "Choose a starting point"}</strong>
          <Show when={listing().path}>
            <button type="button" class="primary" onClick={() => props.onPick(listing().path!)}>
              Use this folder
            </button>
          </Show>
        </div>
        <div class="folders">
          <Show when={listing().path}>
            <button type="button" onClick={() => setPath(listing().parent ?? undefined)}>
              .. (up)
            </button>
          </Show>
          <For
            each={listing().dirs}
            fallback={
              <p class="muted" style={{ padding: "0.5rem" }}>
                No sub-folders
              </p>
            }
          >
            {(d) => (
              <button type="button" onClick={() => setPath(d.path)}>
                {d.name}
              </button>
            )}
          </For>
        </div>
      </Loading>
    </div>
  );
}
