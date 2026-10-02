import type { GameState } from './types'

/** Version of the GameState shape. Bump it whenever a saved or served state would no longer load. */
export const STATE_VERSION = 5

/**
 * Structural sanity check for a GameState that arrived as untyped data (localStorage, the
 * database, the network). It says the shape is renderable, not that the contents are true.
 */
export function isCityStateShape(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<GameState>
  if (s.version !== STATE_VERSION) return false
  if (typeof s.clock !== 'number') return false
  if (!s.buildings || typeof s.buildings !== 'object') return false
  if (!s.users || !s.monuments || !s.capital || !s.crown || !Array.isArray(s.radio) || !s.wards || !s.season?.representatives) return false
  for (const b of Object.values(s.buildings)) {
    if (!b || typeof b.ownerBuilt !== 'number' || typeof b.ward !== 'number' || typeof b.plot !== 'number' || typeof b.patrons !== 'object' || !b.architecture || !Array.isArray(b.landscapeSlots)) return false
  }
  return true
}
