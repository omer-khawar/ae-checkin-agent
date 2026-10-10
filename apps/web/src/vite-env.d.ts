/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the vitals bridge. Defaults to ws://<location.hostname>:8787. */
  readonly VITE_BRIDGE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
