import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import { capitalHolder, capitalScore, computeMonumentHolders, districtTierCounts, tallestBuilding } from './competition'
import { rfToNextTier, tierFor, totalBuilt } from './economy'
import type { Building, GameState } from './types'

export interface ImpactProjection {
  buildingId: string
  amount: number
  fromTier: number
  toTier: number
  monumentChanges: { monumentId: MonumentId; from: DistrictId | null; to: DistrictId | null }[]
  /** Monuments whose top count becomes tied with the holder without a transfer. */
  monumentTies: { monumentId: MonumentId; holder: DistrictId }[]
  capitalChange: { from: DistrictId | null; to: DistrictId | null } | null
  /** Acting district draws level with the Capital without taking it. */
  capitalTie: DistrictId | null
  crownChange: { from: string | null; to: string | null } | null
}

function withExtra(state: GameState, buildingId: string, amount: number): Building[] {
  return Object.values(state.buildings).map((b) =>
    b.id === buildingId ? { ...b, ownerBuilt: b.ownerBuilt + amount } : b,
  )
}

/**
 * Lightweight what-if: adds `amount` RF to a building (owner/community split does not
 * matter for competition) and reports competitive consequences. Pure; state untouched.
 */
export function projectImpact(state: GameState, buildingId: string, amount: number): ImpactProjection {
  const b = state.buildings[buildingId]
  const before = totalBuilt(b)
  const list = withExtra(state, buildingId, amount)
  const incumbents: Partial<Record<MonumentId, DistrictId | null>> = {}
  for (const m of MONUMENTS) incumbents[m.id] = state.monuments[m.id].holder
  const holders = computeMonumentHolders(list, incumbents, b.districtId)
  const counts = districtTierCounts(list)
  const monumentChanges: ImpactProjection['monumentChanges'] = []
  const monumentTies: ImpactProjection['monumentTies'] = []
  for (const m of MONUMENTS) {
    const from = state.monuments[m.id].holder
    const to = holders[m.id]
    if (from !== to) monumentChanges.push({ monumentId: m.id, from, to })
    else if (to && to !== b.districtId && counts[b.districtId][m.tier] === counts[to][m.tier] && tierFor(before + amount) >= m.tier && tierFor(before) < m.tier)
      monumentTies.push({ monumentId: m.id, holder: to })
  }
  const cap = capitalHolder(list, state.capital.holder, b.districtId)
  const beforeScore = capitalScore(districtTierCounts(Object.values(state.buildings))[b.districtId])
  const afterScore = capitalScore(counts[b.districtId])
  const capScore = cap ? capitalScore(counts[cap]) : 0
  const capitalTie = cap && cap !== b.districtId && afterScore > beforeScore && afterScore === capScore ? cap : null
  const crown = tallestBuilding(list, state.crown.holder)
  return {
    buildingId,
    amount,
    fromTier: tierFor(before),
    toTier: tierFor(before + amount),
    monumentChanges,
    monumentTies,
    capitalChange: cap !== state.capital.holder ? { from: state.capital.holder, to: cap } : null,
    capitalTie,
    crownChange: crown !== state.crown.holder ? { from: state.crown.holder, to: crown } : null,
  }
}

/** What-if for exactly reaching the next tier. Null at max tier. */
export function projectTierUp(state: GameState, buildingId: string): ImpactProjection | null {
  const need = rfToNextTier(totalBuilt(state.buildings[buildingId]))
  return need === null ? null : projectImpact(state, buildingId, need)
}

export function impactScore(p: ImpactProjection): number {
  return p.monumentChanges.length * 100 + (p.capitalChange ? 150 : 0) + (p.capitalTie ? 40 : 0) + (p.crownChange ? 80 : 0) + p.monumentTies.length * 25
}

/** Capital points a district gains from one building reaching `toTier` from `fromTier`. */
export function capitalGain(fromTier: number, toTier: number): number {
  const before: Record<number, number> = {}
  const after: Record<number, number> = {}
  for (let t = 1; t <= 6; t++) {
    before[t] = t <= fromTier ? 1 : 0
    after[t] = t <= toTier ? 1 : 0
  }
  return capitalScore(after) - capitalScore(before)
}

export function districtOrder(id: DistrictId): number {
  return DISTRICT_IDS.indexOf(id)
}
