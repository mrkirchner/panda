/// <reference types="vite/client" />

/** Development build (vite.config.ts `define`), as in the TV app's shared code. */
declare const __DEV__: boolean;

interface ImportMetaEnv {
  readonly VITE_SERVED_BY_PANDA?: string;
  readonly VITE_PANDA_SERVER?: string;
}
