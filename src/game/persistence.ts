import { createSeedState, STATE_VERSION } from './seed'
import type { GameState } from './types'

export const STORAGE_KEY = `generations-city:state:v${STATE_VERSION}`

/** Structural sanity check for persisted state; anything stale or malformed falls back to seed. */
export function isValidState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<GameState>
  if (s.version !== STATE_VERSION) return false
  if (typeof s.clock !== 'number') return false
  if (!s.buildings || typeof s.buildings !== 'object' || Object.keys(s.buildings).length === 0) return false
  if (!s.users || !s.monuments || !s.capital || !s.crown || !Array.isArray(s.radio) || !s.wards || !s.season?.representatives) return false
  for (const b of Object.values(s.buildings)) {
    if (!b || typeof b.ownerBuilt !== 'number' || typeof b.ward !== 'number' || typeof b.plot !== 'number' || typeof b.patrons !== 'object' || !b.architecture || !Array.isArray(b.landscapeSlots)) return false
  }
  return true
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
