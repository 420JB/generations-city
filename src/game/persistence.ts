import { createSeedState, STATE_VERSION } from './seed'
import { isCityStateShape } from './stateSchema'
import type { GameState } from './types'

// Legacy key prefix kept on purpose after the Rare City rename: changing it would drop every saved city.
export const STORAGE_KEY = `generations-city:state:v${STATE_VERSION}`

/** Structural sanity check for persisted state; anything stale or malformed falls back to seed. */
export function isValidState(value: unknown): value is GameState {
  // A saved demo city always has buildings; an empty one is treated as corrupt.
  return isCityStateShape(value) && Object.keys(value.buildings).length > 0
}

export function loadState(storage: Pick<Storage, 'getItem'> | null): { state: GameState; restored: boolean } {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (isValidState(parsed)) return { state: parsed, restored: true }
    }
  } catch {
    // Corrupt JSON or storage unavailable — reseed.
  }
  return { state: createSeedState(), restored: false }
}

export function saveState(storage: Pick<Storage, 'setItem'> | null, state: GameState): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function clearState(storage: Pick<Storage, 'removeItem'> | null) {
  try {
    for (const key of [STORAGE_KEY]) storage?.removeItem(key)
  } catch {
    // ignore
  }
}
