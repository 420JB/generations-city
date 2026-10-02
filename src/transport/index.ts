import { createLocalTransport } from './local'
import { resolveClientMode } from './mode'
import type { CityTransport } from './types'

export type { CitySnapshot, CityTransport, ClientCommand, Viewer } from './types'

let transport: CityTransport | null = null

/** The app's single transport, created on first use for the mode this bundle was built for. */
export function getTransport(): CityTransport {
  if (transport) return transport
  const mode = resolveClientMode(import.meta.env.VITE_APP_MODE)
  if (mode === 'server') throw new Error('VITE_APP_MODE=server is not available yet: this build ships the local demo transport only.')
  transport = createLocalTransport(typeof window !== 'undefined' ? window.localStorage : null)
  return transport
}
