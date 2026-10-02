// `src/config` reads Vite's BASE_URL when bundled for the browser. Under Node it is absent,
// and the shared code already falls back; this only teaches the server type-check about it.
interface ImportMetaEnv {
  readonly BASE_URL?: string
}

interface ImportMeta {
  readonly env?: ImportMetaEnv
}
