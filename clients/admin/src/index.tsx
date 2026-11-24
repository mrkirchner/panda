import "./styles.css";
import { createMemo, Errored, Loading, refresh, Show } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import { api } from "./api/client";
import { Frame } from "./components/Frame";
import { ErrorView } from "./components/ui";
import Login from "./pages/Login";
import { PUBLIC_PATHS, Router } from "./router";
import { SessionContext } from "./session";

function Shell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const me = createMemo(() => api.me());
  const isPublic = () => PUBLIC_PATHS.some((p) => location.pathname.startsWith(p));

  return (
    <SessionContext value={{ me, reload: () => refresh(me) }}>
      <Errored
        fallback={(err, reset) => (
          <div class="center">
            <ErrorView error={err()} retry={reset} />
          </div>
        )}
      >
        <Loading fallback={<div class="center muted">Loading...</div>}>
          <Show when={!isPublic()} fallback={<div class="center">{props.children}</div>}>
            <Show
              when={me()}
              fallback={
                <div class="center">
                  <Login />
                </div>
              }
            >
              {(m) => <Frame me={m()}>{props.children}</Frame>}
            </Show>
          </Show>
        </Loading>
      </Errored>
    </SessionContext>
  );
}

render(() => <Router>{(props) => <Shell>{props.children}</Shell>}</Router>, document.getElementById("app")!);
