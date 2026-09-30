import { DEFAULT_ARCHITECTURE } from '../config/architecture'
import { LANDSCAPE_MAX_SLOTS } from '../config/economy'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { wardCapacity } from './world'
import type { Building, GameState } from './types'

/**
 * Plot allocation: a Friend only receives a property once it becomes active in the city.
 * Plots fill ward by ward; when every open ward in a district is full, the next ward
 * (one band farther out) opens. Pure and deterministic.
 */

export interface PlotAddress {
  districtId: DistrictId
  ward: number
  plot: number
}

export function occupiedPlots(state: Pick<GameState, 'buildings'>, districtId: DistrictId): Set<string> {
  const out = new Set<string>()
  for (const b of Object.values(state.buildings)) if (b.districtId === districtId) out.add(`${b.ward}:${b.plot}`)
  return out
}

export function wardPopulation(state: Pick<GameState, 'buildings'>, districtId: DistrictId, ward: number): number {
  let n = 0
  for (const b of Object.values(state.buildings)) if (b.districtId === districtId && b.ward === ward) n++
  return n
}

/** First free plot in the lowest open ward, or null if all open wards are full. */
export function findAvailablePlot(state: Pick<GameState, 'buildings' | 'wards'>, districtId: DistrictId): PlotAddress | null {
  const used = occupiedPlots(state, districtId)
  const open = state.wards[districtId] ?? 1
  for (let ward = 0; ward < open; ward++) {
    const cap = wardCapacity(ward)
    for (let plot = 0; plot < cap; plot++) if (!used.has(`${ward}:${plot}`)) return { districtId, ward, plot }
  }
  return null
}

export interface Allocation {
  address: PlotAddress
  /** True when this allocation had to open a new ward. */
  openedWard: boolean
  wards: Record<DistrictId, number>
}

/** Find a plot, opening the next ward if the district is at capacity. */
export function allocatePlot(
  state: Pick<GameState, 'buildings' | 'wards'>,
  districtId: DistrictId,
  /** Optional safety cap for callers; production and the demo pass none (unbounded). */
  maxWards: number = Number.POSITIVE_INFINITY,
): Allocation | null {
  const free = findAvailablePlot(state, districtId)
  if (free) return { address: free, openedWard: false, wards: state.wards }
  const open = state.wards[districtId] ?? 1
  if (open >= maxWards) return null
  return {
    address: { districtId, ward: open, plot: 0 },
    openedWard: true,
    wards: { ...state.wards, [districtId]: open + 1 },
  }
}

/**
 * EXPLICIT PLACEMENT (human onboarding). A Friend's family fixes the district; the player
 * picks the exact plot. Location is preference only: no plot carries any gameplay value.
 */
export interface PlotCandidate extends PlotAddress {
  /** True when this plot lies in the next ward, which opens only if a Friend joins here. */
  newWard: boolean
}

/**
 * Every plot a joining Friend may choose in a district: all free plots in the open wards,
 * or, when every open ward is full, every plot of the NEXT ward (previewed, not opened).
 * Pure: computing candidates never changes state.
 */
export function availablePlots(state: Pick<GameState, 'buildings' | 'wards'>, districtId: DistrictId): PlotCandidate[] {
  const used = occupiedPlots(state, districtId)
  const open = state.wards[districtId] ?? 1
  const out: PlotCandidate[] = []
  for (let ward = 0; ward < open; ward++)
    for (let plot = 0; plot < wardCapacity(ward); plot++) if (!used.has(`${ward}:${plot}`)) out.push({ districtId, ward, plot, newWard: false })
  if (out.length > 0) return out
  return Array.from({ length: wardCapacity(open) }, (_, plot) => ({ districtId, ward: open, plot, newWard: true }))
}

/** Allocation for an exact, player-chosen plot, or null if it is not a valid candidate. */
export function allocateSpecificPlot(state: Pick<GameState, 'buildings' | 'wards'>, address: PlotAddress): Allocation | null {
  const { districtId, ward, plot } = address
  if (!DISTRICT_IDS.includes(districtId) || !Number.isInteger(ward) || !Number.isInteger(plot)) return null
  const pick = availablePlots(state, districtId).find((c) => c.ward === ward && c.plot === plot)
  if (!pick) return null
  const open = state.wards[districtId] ?? 1
  return {
    address: { districtId, ward, plot },
    openedWard: pick.newWard,
    wards: pick.newWard ? { ...state.wards, [districtId]: open + 1 } : state.wards,
  }
}

export interface DistrictGrowth {
  districtId: DistrictId
  openWards: number
  population: number
  capacity: number
  wards: { ward: number; population: number; capacity: number }[]
}

export function districtGrowth(state: Pick<GameState, 'buildings' | 'wards'>, districtId: DistrictId): DistrictGrowth {
  const open = state.wards[districtId] ?? 1
  const wards = Array.from({ length: open }, (_, ward) => ({
    ward,
    population: wardPopulation(state, districtId, ward),
    capacity: wardCapacity(ward),
  }))
  return {
    districtId,
    openWards: open,
    population: wards.reduce((a, w) => a + w.population, 0),
    capacity: wards.reduce((a, w) => a + w.capacity, 0),
    wards,
  }
}

export function initialWards(): Record<DistrictId, number> {
  return Object.fromEntries(DISTRICT_IDS.map((d) => [d, 1])) as Record<DistrictId, number>
}

/** A brand-new, unbuilt property for a Friend that just became active. */
export function newBuilding(params: { friendId: number; ownerId: string; address: PlotAddress; clock: number }): Building {
  const { friendId, ownerId, address } = params
  return {
    id: `b-${friendId}`,
    friendId,
    ownerId,
    districtId: address.districtId,
    ward: address.ward,
    plot: address.plot,
    ownerBuilt: 0,
    patrons: {},
    architecture: { ...DEFAULT_ARCHITECTURE },
    fixtures: [],
    landscapeInventory: {},
    landscapeSlots: Array(LANDSCAPE_MAX_SLOTS).fill(null),
    billboard: { image: null, updatedClock: null },
    milestones: [],
  }
}

/** Roman numerals for ward names (Ward I = the district core). */
/** Roman numeral for any positive integer. */
export function roman(n: number): string {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let out = ''
  let v = n
  for (const [k, sym] of table) while (v >= k) {
    out += sym
    v -= k
  }
  return out
}

/** Ward names: Ward I (the Founding Ward), Ward II, … with no upper limit. */
export function wardName(ward: number): string {
  return `Ward ${roman(ward + 1)}`
}

/** Ward I is the Founding Ward: a prestige/history designation only, never a gameplay bonus. */
export function isFoundingWard(ward: number): boolean {
  return ward === 0
}
