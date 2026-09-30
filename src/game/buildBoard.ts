import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import { capitalScore, districtTierCounts } from './competition'
import { rfToNextTier, tierFloor, tierFor, totalBuilt } from './economy'
import { describeImpact } from './narration'
import { capitalGain, impactScore, projectImpact } from './projection'
import type { GameState } from './types'

export interface Opportunity {
  buildingId: string
  rfNeeded: number
  nextTier: number
  lines: string[]
  score: number
}

export interface MonumentRow {
  monumentId: MonumentId
  holder: DistrictId | null
  holderCount: number
  districtCount: number
  status: 'held' | 'capture-next' | 'tie-next' | 'behind' | 'unclaimed'
  /** Building in this district closest to reaching the monument tier. */
  candidate: Opportunity | null
}

export interface CapitalRow {
  mode: 'defense' | 'offense'
  capital: DistrictId | null
  districtScore: number
  rivalDistrict: DistrictId | null
  rivalScore: number
  gap: number
  candidates: (Opportunity & { points: number })[]
}

export interface BuildBoard {
  districtId: DistrictId
  closest: Opportunity[]
  impact: Opportunity[]
  monuments: MonumentRow[]
  capital: CapitalRow
}

/** Strategic value per RF, damped so large swings still rank when they are far away. */
function efficiency(o: Opportunity): number {
  return o.score / Math.sqrt(Math.max(1, o.rfNeeded))
}

function opportunity(state: GameState, buildingId: string): Opportunity | null {
  const total = totalBuilt(state.buildings[buildingId])
  const need = rfToNextTier(total)
  if (need === null) return null
  const p = projectImpact(state, buildingId, need)
  return { buildingId, rfNeeded: need, nextTier: tierFor(total) + 1, lines: describeImpact(state, p), score: impactScore(p) }
}

export function buildBoard(state: GameState, districtId: DistrictId): BuildBoard {
  const inDistrict = Object.values(state.buildings)
    .filter((b) => b.districtId === districtId)
    .sort((a, b) => a.id.localeCompare(b.id))
  const opps = inDistrict.map((b) => opportunity(state, b.id)).filter((o): o is Opportunity => o !== null)

  const closest = [...opps].sort((a, b) => a.rfNeeded - b.rfNeeded || a.buildingId.localeCompare(b.buildingId)).slice(0, 3)
  const impact = opps
    .filter((o) => o.score > 0)
    .sort((a, b) => efficiency(b) - efficiency(a) || a.rfNeeded - b.rfNeeded)
    .slice(0, 3)

  const counts = districtTierCounts(Object.values(state.buildings))
  const monuments: MonumentRow[] = MONUMENTS.map((m) => {
    const holder = state.monuments[m.id].holder
    const holderCount = holder ? counts[holder][m.tier] : 0
    const districtCount = counts[districtId][m.tier]
    const below = inDistrict
      .filter((b) => tierFor(totalBuilt(b)) < m.tier)
      .map((b) => ({ b, need: tierFloor(m.tier) - totalBuilt(b) }))
      .sort((a, z) => a.need - z.need)[0]
    let candidate: Opportunity | null = null
    if (below) {
      const p = projectImpact(state, below.b.id, below.need)
      candidate = { buildingId: below.b.id, rfNeeded: below.need, nextTier: m.tier, lines: describeImpact(state, p), score: impactScore(p) }
    }
    let status: MonumentRow['status']
    if (holder === districtId) status = 'held'
    else if (!holder) status = candidate ? 'capture-next' : 'unclaimed'
    else if (districtCount + 1 > holderCount) status = 'capture-next'
    else if (districtCount + 1 === holderCount) status = 'tie-next'
    else status = 'behind'
    return { monumentId: m.id, holder, holderCount, districtCount, status, candidate }
  })

  const scores = Object.fromEntries(DISTRICT_IDS.map((d) => [d, capitalScore(counts[d])])) as Record<DistrictId, number>
  const capitalId = state.capital.holder
  const mode: CapitalRow['mode'] = capitalId === districtId ? 'defense' : 'offense'
  const rivalDistrict =
    mode === 'defense'
      ? DISTRICT_IDS.filter((d) => d !== districtId).sort((a, b) => scores[b] - scores[a])[0]
      : capitalId
  const rivalScore = rivalDistrict ? scores[rivalDistrict] : 0
  const candidates = opps
    .map((o) => {
      const b = state.buildings[o.buildingId]
      const tier = tierFor(totalBuilt(b))
      return { ...o, points: capitalGain(tier, tier + 1) }
    })
    .sort((a, b) => b.points / b.rfNeeded - a.points / a.rfNeeded || a.rfNeeded - b.rfNeeded)
    .slice(0, 3)
  return {
    districtId,
    closest,
    impact,
    monuments,
    capital: {
      mode,
      capital: capitalId,
      districtScore: scores[districtId],
      rivalDistrict,
      rivalScore,
      gap: mode === 'defense' ? scores[districtId] - rivalScore : rivalScore - scores[districtId],
      candidates,
    },
  }
}

/** City-wide highest-impact opportunities across every district. */
export function cityHotlist(state: GameState, limit = 4): Opportunity[] {
  return Object.keys(state.buildings)
    .sort()
    .map((id) => opportunity(state, id))
    .filter((o): o is Opportunity => o !== null && o.score >= 100)
    .sort((a, b) => efficiency(b) - efficiency(a) || a.rfNeeded - b.rfNeeded)
    .slice(0, limit)
}
