import { createContext } from "solid-js";
import type { Me } from "./api/types";

export interface SessionCtx {
  /** Signed-in user, or `null`. Async: read it under a `<Loading>` boundary. */
  me: () => Me | null;
  /** Re-fetch `me` (after login, logout, password change). */
  reload: () => void;
}

export const SessionContext = createContext<SessionCtx>();
