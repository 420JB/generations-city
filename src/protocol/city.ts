import { isCityStateShape, STATE_VERSION } from '../game/stateSchema'
import type { GameState } from '../game/types'

/**
 * Wire contract for the shared city read path, used by both the server and the client.
 * Portable: no browser or Node dependency.
 *
 * The city is one document shared by every visitor, so nothing in it says who is looking.
 * Identity has its own contract (`./identity`) and its own endpoint.
 */
export const CITY_ENDPOINT = '/v1/city'

/**
 * Who is ACTING in the city on screen. A viewer with an id can act; an anonymous visitor
 * can only browse. The authority decides this, never the UI, and there is no way to
 * express an anonymous viewer that carries a user id.
 *
 * This is the city actor, not the signed-in wallet: a server-backed city has no actors
 * until properties can be activated, so there it is always anonymous.
 */
export type Viewer = { userId: string; source: 'demo' | 'session' } | { userId: null; source: 'anonymous' }

export const ANONYMOUS_VIEWER: Viewer = { userId: null, source: 'anonymous' }

/** `genesis` is canonical. `demo-fixture` is the familiar demo city installed for staging and tests. */
export type CityOrigin = 'genesis' | 'demo-fixture'

export type ServerMode = 'local' | 'staging' | 'production'

export interface CityMeta {
  id: string
  /** Identity of this installation of the city. It changes if the city is ever wiped and reinstalled. */
  instance: string
  /** Increases by one with every authoritative change. */
  sequence: number
  stateVersion: number
  /** false = non-canonical staging/test state that will be wiped before real RF. */
  canonical: boolean
  origin: CityOrigin
  updatedAt: string
}

export interface CityResponse {
  city: CityMeta
  server: { mode: ServerMode }
  state: GameState
}

/** Error bodies are `{ "error": <code> }`. */
export type CityErrorCode = 'city_not_initialized' | 'city_state_unsupported' | 'city_state_invalid' | 'city_unavailable'

export type ParsedCity = { ok: true; response: CityResponse } | { ok: false; reason: 'malformed' | 'unsupported-version' }

/**
 * Validate a `/v1/city` body that arrived as untyped JSON. Nothing unvalidated reaches the renderer.
 *
 * Only the contract's own keys are returned. A `viewer` key (sent by servers before
 * identity moved to `/v1/viewer`) is ignored: the city body is never a source of identity.
 */
export function parseCityResponse(value: unknown): ParsedCity {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' }
  const r = value as Partial<CityResponse>
  const c = r.city as Partial<CityMeta> | undefined
  if (!c || typeof c !== 'object') return { ok: false, reason: 'malformed' }
  if (typeof c.id !== 'string' || typeof c.instance !== 'string' || !c.instance) return { ok: false, reason: 'malformed' }
  if (typeof c.sequence !== 'number' || !Number.isSafeInteger(c.sequence) || c.sequence < 1) return { ok: false, reason: 'malformed' }
  if (typeof c.canonical !== 'boolean' || (c.origin !== 'genesis' && c.origin !== 'demo-fixture') || typeof c.updatedAt !== 'string') return { ok: false, reason: 'malformed' }
  if (typeof c.stateVersion !== 'number') return { ok: false, reason: 'malformed' }
  if (c.stateVersion !== STATE_VERSION) return { ok: false, reason: 'unsupported-version' }
  const mode = (r.server as { mode?: unknown } | undefined)?.mode
  if (mode !== 'local' && mode !== 'staging' && mode !== 'production') return { ok: false, reason: 'malformed' }
  if (!isCityStateShape(r.state)) return { ok: false, reason: 'malformed' }
  const city: CityMeta = { id: c.id, instance: c.instance, sequence: c.sequence, stateVersion: c.stateVersion, canonical: c.canonical, origin: c.origin, updatedAt: c.updatedAt }
  return { ok: true, response: { city, server: { mode }, state: r.state } }
}
