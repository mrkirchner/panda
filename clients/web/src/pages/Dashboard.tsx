import { createMemo, For, Loading, onSettled, refresh, Show } from "solid-js";
import { api } from "../api/client";
import { AdminOnly } from "../components/Frame";
import { Card, Notice, useAction } from "../components/ui";
import { ago } from "../format";

export default function Dashboard() {
  return (
    <AdminOnly>
      <DashboardInner />
    </AdminOnly>
  );
}

function DashboardInner() {
  const system = createMemo(() => api.system());
  const sessions = createMemo(() => api.sessions());
  const streams = createMemo(() => api.streams());
  const offline = createMemo(() => api.offlineLibraries());
  const scan = useAction();
  // Live-ish view of who is streaming.
  onSettled(() => {
    const id = setInterval(() => {
      refresh(streams);
      refresh(offline);
    }, 5000);
    return () => clearInterval(id);
  });

  return (
    <>
      <h1>Dashboard</h1>
      <Loading fallback={null}>
        <Show when={offline().length > 0}>
          <Notice kind="error">
            {offline().join(", ")} {offline().length === 1 ? "is" : "are"} offline: Panda can't reach the
            storage (is the NAS on and connected?). Nothing is removed from the library meanwhile, and it's
            rescanned automatically when it's back.
          </Notice>
        </Show>
      </Loading>
      <Loading fallback={<p class="muted">Loading...</p>}>
        <Show when={!system().tmdb || system().libraries.length === 0}>
          <Card title="Finish setting up">
            <ul>
              <Show when={system().libraries.length === 0}>
                <li>
                  <a href="/libraries">Add a library</a> (a folder of movies or shows).
                </li>
              </Show>
              <Show when={!system().tmdb}>
                <li>
                  <a href="/settings">Add a TMDB token</a> for posters, plots and episode names.
                </li>
              </Show>
              <li>
                <a href="/users">Invite people</a> and <a href="/link">pair a TV</a>.
              </li>
            </ul>
          </Card>
        </Show>

        <div class="grid">
          <For each={system().libraries}>
            {(l) => (
              <Card>
                <div class="muted">{l.name}</div>
                <div class="stat">{l.items.toLocaleString()}</div>
                <div class="muted">
                  {l.kind === "movies" ? "movies" : "episodes"}
                  <Show when={l.unmatched > 0}>
                    {" "}
                    <span class="badge warn">{l.unmatched} unmatched</span>
                  </Show>
                </div>
              </Card>
            )}
          </For>
          <Card>
            <div class="muted">Signed-in devices</div>
            <div class="stat">{sessions().filter((s) => s.kind === "device").length}</div>
            <div class="muted">
              <a href="/devices">manage</a>
            </div>
          </Card>
        </div>

        <Card title="Active streams">
          <p class="muted">
            Transcode slots in use: hardware {streams().in_use.hardware}/{streams().limits.hardware}, software{" "}
            {streams().in_use.software}/{streams().limits.software}. Remuxes ({streams().in_use.remux}) and
            direct play are never limited (direct play isn't listed: it needs no server-side work).
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Title</th>
                  <th>Output</th>
                  <th>Engine</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={streams().streams}
                  fallback={
                    <tr>
                      <td colspan="5" class="muted">
                        Nothing is transcoding.
                      </td>
                    </tr>
                  }
                >
                  {(s) => (
                    <tr>
                      <td>{s.user ?? "?"}</td>
                      <td>{s.title ?? `#${s.stream.item_id}`}</td>
                      <td>{s.stream.output}</td>
                      <td>
                        <span
                          class={[
                            "badge",
                            { ok: s.stream.slot === "hardware", warn: s.stream.slot === "software" },
                          ]}
                        >
                          {s.stream.slot === "remux" ? "remux (copy)" : s.stream.pipeline}
                        </span>
                      </td>
                      <td>{ago(s.stream.started_at)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Library scan">
          <div class="row">
            <button class="primary" disabled={scan.busy()} onClick={() => scan.run(() => api.scan())}>
              Scan all libraries now
            </button>
            <span class="muted">Runs in the background. New files are probed and matched automatically.</span>
          </div>
          <Show when={scan.error()}>
            <Notice kind="error">{scan.error()}</Notice>
          </Show>
        </Card>

        <Card title="Transcoding">
          <table>
            <tbody>
              <tr>
                <th>FFmpeg</th>
                <td>
                  <span class={["badge", system().ffmpeg.flavor === "jellyfin" ? "ok" : "warn"]}>
                    {system().ffmpeg.flavor === "jellyfin" ? "jellyfin-ffmpeg" : "stock ffmpeg"}
                  </span>{" "}
                  <span class="muted mono">{system().ffmpeg.path}</span>
                </td>
              </tr>
              <tr>
                <th>Hardware acceleration</th>
                <td>{system().ffmpeg.hwaccels.join(", ") || "none detected (software encoding)"}</td>
              </tr>
              <tr>
                <th>HDR tone mapping</th>
                <td>
                  <Show
                    when={system().ffmpeg.tonemap.length}
                    fallback={
                      <span class="badge warn">unavailable: install jellyfin-ffmpeg for HDR to SDR</span>
                    }
                  >
                    {system().ffmpeg.tonemap.join(", ")}
                  </Show>
                </td>
              </tr>
              <tr>
                <th>Integrations</th>
                <td class="row">
                  <span class={["badge", system().tmdb ? "ok" : "warn"]}>TMDB</span>
                  <span class={["badge", system().radarr ? "ok" : ""]}>Radarr</span>
                  <Show when={system().radarr_4k}>
                    <span class="badge ok">Radarr 4K</span>
                  </Show>
                  <span class={["badge", system().sonarr ? "ok" : ""]}>Sonarr</span>
                  <Show when={system().sonarr_4k}>
                    <span class="badge ok">Sonarr 4K</span>
                  </Show>
                </td>
              </tr>
              <tr>
                <th>Panda</th>
                <td>v{system().version}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </Loading>
    </>
  );
}
