import type { CityCommand } from '../game/commands'
import type { DemoCommand } from '../game/demoCommands'
import type { GameEvent, GameState } from '../game/types'

/**
 * Who is looking at the city. The transport owns this, never the UI: the local demo
 * resolves it to the demo player, a server transport will derive it from the session.
 */
export interface Viewer {
  userId: string
  source: 'demo' | 'session'
}

/** Everything a client may send. `reset` reseeds the local demo city and exists only there. */
export type ClientCommand = CityCommand | DemoCommand | { type: 'reset' }

/** READ side: the city read model the client renders, plus the outcome of the latest command. */
export interface CitySnapshot {
  game: GameState
  viewer: Viewer
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
