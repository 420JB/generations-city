/**
 * District tier monuments: large civic landmarks. The district with the most buildings
 * at-or-above the monument's tier holds it; ties keep the incumbent. Monuments stand in
 * the holder's civic square and physically move when overtaken.
 */
export interface MonumentDef {
  id: MonumentId
  tier: number
  name: string
  short: string
  kind: 'arch' | 'obelisk' | 'fountain' | 'statue' | 'beacon'
  blurb: string
}

export type MonumentId = 'm2' | 'm3' | 'm4' | 'm5' | 'm6'

export const MONUMENTS: readonly MonumentDef[] = [
  { id: 'm2', tier: 2, name: "The Founders' Arch", short: 'T2 Arch', kind: 'arch', blurb: 'Triumphal arch · most Tier 2+ buildings' },
  { id: 'm3', tier: 3, name: "The Builders' Obelisk", short: 'T3 Obelisk', kind: 'obelisk', blurb: 'Gilded obelisk · most Tier 3+ buildings' },
  { id: 'm4', tier: 4, name: 'The Grand Fountain', short: 'T4 Fountain', kind: 'fountain', blurb: 'Three-tier fountain · most Tier 4+ buildings' },
  { id: 'm5', tier: 5, name: 'The Friend Statue', short: 'T5 Statue', kind: 'statue', blurb: "Bronze cast of the holding family's Friend · most Tier 5+ buildings" },
  { id: 'm6', tier: 6, name: 'The Beacon Tower', short: 'T6 Beacon', kind: 'beacon', blurb: 'Lighthouse wonder · most Tier 6 buildings' },
]

const byId = new Map(MONUMENTS.map((m) => [m.id, m]))
export function getMonument(id: MonumentId): MonumentDef {
  const m = byId.get(id)
  if (!m) throw new Error(`Unknown monument ${id}`)
  return m
}
