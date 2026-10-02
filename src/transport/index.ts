import { createLocalTransport } from './local'
import { resolveClientMode } from './mode'
import { createServerTransport } from './server'
import type { CityTransport } from './types'

export type { CitySnapshot, CityTransport, ClientCommand, Connection, Viewer } from './types'

let transport: CityTransport | null = null

/** The app's single transport, created on first use for the mode this bundle was built for. */
export function getTransport(): CityTransport {
  if (transport) return transport
  const mode = resolveClientMode(import.meta.env.VITE_APP_MODE)
  transport =
    mode === 'server'
      ? // Same origin: the Rare City service serves this page and the API. No storage is handed over.
        createServerTransport({ fetch: (input, init) => window.fetch(input, init) })
      : createLocalTransport(typeof window !== 'undefined' ? window.localStorage : null)
  return transport
}
