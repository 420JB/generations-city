import type { CityCommand } from '../game/commands'
import type { DemoCommand } from '../game/demoCommands'
import type { GameEvent, GameState } from '../game/types'
import type { Viewer } from '../protocol/city'

export type { Viewer }

/** Everything a client may send. `reset` reseeds the local demo city and exists only there. */
export type ClientCommand = CityCommand | DemoCommand | { type: 'reset' }

/**
 * Where the city on screen comes from.
 * - `local`       the demo city in this browser; nothing to connect to.
 * - `connecting`  no city yet; the first authoritative read is in flight.
 * - `live`        the last read from the server succeeded.
 * - `stale`       the last read failed; the city shown is the last one the server sent.
 * - `unavailable` no city to show: the server cannot be reached or has none.
 */
export type ConnectionStatus = 'local' | 'connecting' | 'live' | 'stale' | 'unavailable'

export interface Connection {
  status: ConnectionStatus
  /** Authoritative sequence of the city on screen (null for the local demo and before the first read). */
  sequence: number | null
  /** false when the server says this city is non-canonical staging/test state. */
  canonical: boolean | null
  /** Why the connection is stale or unavailable, in words fit for the page. */
  message: string | null
}

/** READ side: the city read model the client renders, plus the outcome of the latest command. */
export interface CitySnapshot {
  /** null only while a server-backed city has not arrived yet. */
  game: GameState | null
  viewer: Viewer
  connection: Connection
  /** Events from the most recent successful command, tagged with a sequence number. */
  last: { seq: number; events: GameEvent[]; action: ClientCommand['type'] } | null
  error: { seq: number; message: string } | null
  seq: number
  restored: boolean
  saveFailed: boolean
}

/**
 * The authority seam between the UI and whoever owns the city.
 *
 * Reads are `getSnapshot` + `subscribe`; the snapshot object is replaced, never mutated.
 * `send` is the only way to change the city, and its outcome arrives as a new snapshot,
 * so a transport is free to settle a command synchronously (local) or after a round trip.
 */
export interface CityTransport {
  getSnapshot(): CitySnapshot
  subscribe(listener: () => void): () => void
  send(command: ClientCommand): void
}
