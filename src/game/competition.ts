import { CAPITAL_WEIGHTS, MAX_TIER } from '../config/economy'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import { tierFor, totalBuilt } from './economy'
import type { Building, GameState } from './types'

export type TierCounts = Record<number, number>

/**
 * Cumulative tier attainment per district: a Tier 5 building counts toward
 * Tiers 1..5. Upgrading a building can never reduce a lower-tier count.
 */
export function districtTierCounts(buildings: Iterable<Building>): Record<DistrictId, TierCounts> {
  const out = {} as Record<DistrictId, TierCounts>
  for (const id of DISTRICT_IDS) {
    out[id] = {}
    for (let t = 1; t <= MAX_TIER; t++) out[id][t] = 0
  }
  for (const b of buildings) {
    const tier = tierFor(totalBuilt(b))
    for (let t = 1; t <= tier; t++) out[b.districtId][t] += 1
  }
  return out
}

/**
 * Winner of a contested holding. The district(s) with the highest value win;
 * an incumbent tied at the top keeps it; among tied challengers the acting
 * district is preferred, then district order. Zero means unclaimed.
 */
export function resolveHolder(
  values: Record<DistrictId, number>,
  incumbent: DistrictId | null,
  actingDistrict: DistrictId | null = null,
): DistrictId | null {
  let max = 0
  for (const id of DISTRICT_IDS) max = Math.max(max, values[id] ?? 0)
  if (max <= 0) return null
  const top = DISTRICT_IDS.filter((id) => (values[id] ?? 0) === max)
  if (incumbent && top.includes(incumbent)) return incumbent
  if (actingDistrict && top.includes(actingDistrict)) return actingDistrict
  return top[0]
}

export function monumentHolder(
  counts: Record<DistrictId, TierCounts>,
  monumentTier: number,
  incumbent: DistrictId | null,
  actingDistrict: DistrictId | null = null,
): DistrictId | null {
  const values = {} as Record<DistrictId, number>
  for (const id of DISTRICT_IDS) values[id] = counts[id][monumentTier] ?? 0
  return resolveHolder(values, incumbent, actingDistrict)
}

export function computeMonumentHolders(
  buildings: Iterable<Building>,
  incumbents: Partial<Record<MonumentId, DistrictId | null>>,
  actingDistrict: DistrictId | null = null,
): Record<MonumentId, DistrictId | null> {
  const counts = districtTierCounts(buildings)
  const out = {} as Record<MonumentId, DistrictId | null>
  for (const m of MONUMENTS) out[m.id] = monumentHolder(counts, m.tier, incumbents[m.id] ?? null, actingDistrict)
  return out
}

/** Capital score: weighted cumulative tier counts. Not total RF burned. */
export function capitalScore(counts: TierCounts): number {
  let score = 0
  for (let t = 1; t <= MAX_TIER; t++) score += (counts[t] ?? 0) * (CAPITAL_WEIGHTS[t] ?? 0)
  return score
}

export interface DistrictStanding {
  districtId: DistrictId
  score: number
  counts: TierCounts
  rank: number
}

export function districtStandings(
  buildings: Iterable<Building>,
  incumbentCapital: DistrictId | null,
): DistrictStanding[] {
  const counts = districtTierCounts(buildings)
  const rows = DISTRICT_IDS.map((id) => ({ districtId: id, score: capitalScore(counts[id]), counts: counts[id], rank: 0 }))
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.districtId === incumbentCapital) return -1
    if (b.districtId === incumbentCapital) return 1
    return DISTRICT_IDS.indexOf(a.districtId) - DISTRICT_IDS.indexOf(b.districtId)
  })
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

export function capitalHolder(
  buildings: Iterable<Building>,
  incumbent: DistrictId | null,
  actingDistrict: DistrictId | null = null,
): DistrictId | null {
  const counts = districtTierCounts(buildings)
  const values = {} as Record<DistrictId, number>
  for (const id of DISTRICT_IDS) values[id] = capitalScore(counts[id])
  return resolveHolder(values, incumbent, actingDistrict)
}

/**
 * Tallest building (City Crown). Height is strictly monotonic in Total RF Built,
 * so the tallest is the highest total; the incumbent keeps the Crown on a tie.
 */
export function tallestBuilding(buildings: Iterable<Building>, incumbent: string | null): string | null {
  let best: Building | null = null
  let bestTotal = -1
  const list = [...buildings].sort((a, b) => a.id.localeCompare(b.id))
  for (const b of list) {
    const t = totalBuilt(b)
    if (t > bestTotal || (t === bestTotal && b.id === incumbent)) {
      best = b
      bestTotal = t
    }
  }
  return bestTotal > 0 && best ? best.id : null
}

export function buildingsOf(state: GameState): Building[] {
  return Object.values(state.buildings)
}
