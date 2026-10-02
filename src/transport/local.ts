import { DEMO_PLAYER_ID } from '../config/identity'
import { applyCityCommand } from '../game/commands'
import { applyDemoCommand, isDemoCommand } from '../game/demoCommands'
import { clearState, loadState, saveState } from '../game/persistence'
import { createSeedState } from '../game/seed'
import type { ActionResult, GameState } from '../game/types'
import type { CitySnapshot, CityTransport, ClientCommand, Viewer } from './types'

export const DEMO_VIEWER: Viewer = { userId: DEMO_PLAYER_ID, source: 'demo' }

export type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Run one command against browser-local state as `viewer`. Pure. */
export function executeLocal(game: GameState, viewer: Viewer, command: ClientCommand): ActionResult {
  if (command.type === 'reset') return { state: createSeedState(), events: [] }
  if (isDemoCommand(command)) return applyDemoCommand(game, viewer.userId, command)
  return applyCityCommand(game, viewer.userId, command)
}

/**
 * LOCAL DEMO authority: the deterministic engine runs in this browser and the city lives
 * in localStorage. Commands settle synchronously, exactly as the demo always has.
 */
export function createLocalTransport(storage: LocalStorageLike | null, viewer: Viewer = DEMO_VIEWER): CityTransport {
  const listeners = new Set<() => void>()
  const { state, restored } = loadState(storage)
  let snapshot: CitySnapshot = { game: state, viewer, last: null, error: null, seq: 0, restored, saveFailed: false }
  saveState(storage, snapshot.game)

  const publish = (next: CitySnapshot) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    send(command) {
      const seq = snapshot.seq + 1
      const r = executeLocal(snapshot.game, viewer, command)
      if (r.error) {
        publish({ ...snapshot, seq, error: { seq, message: r.error } })
        return
      }
      if (command.type === 'reset') clearState(storage)
      saveState(storage, r.state)
      publish({ ...snapshot, seq, game: r.state, last: { seq, events: r.events, action: command.type }, error: null })
    },
  }
}
