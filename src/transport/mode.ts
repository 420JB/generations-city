/**
 * Client runtime mode, chosen at build time with VITE_APP_MODE.
 *
 * - `local-demo` (default): the engine and the city live in this browser.
 * - `server`: the city is owned by the Rare City service. Not implemented yet.
 */
export type ClientMode = 'local-demo' | 'server'

export const CLIENT_MODES: readonly ClientMode[] = ['local-demo', 'server']

/** Unknown values fail loudly: a typo must never fall back to a browser-authoritative city. */
export function resolveClientMode(raw: string | undefined): ClientMode {
  if (raw === undefined || raw === '') return 'local-demo'
  if ((CLIENT_MODES as readonly string[]).includes(raw)) return raw as ClientMode
  throw new Error(`Unknown VITE_APP_MODE "${raw}". Expected one of: ${CLIENT_MODES.join(', ')}.`)
}
