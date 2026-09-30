import type { DistrictId } from '../config/districts'
import { allocatePlot, newBuilding, wardName } from './allocation'
import { EMPTY_COUNTERS } from './badges'
import { appendRadio, districtTitle } from './narration'
import type { ActionResult, Building, DemoUser, GameState, RadioEntry } from './types'

/**
 * DEMO-ONLY district growth simulator.
 *
 * Proves the real scaling path (City → District → Ward → Plot → Building): it activates
 * deterministic SIMULATED residents one at a time through the normal plot allocator
 * (`allocatePlot` + `newBuilding`) and stops the moment the allocator has to open the
 * district's next ward. Other districts are never touched.
 *
 * Simulated residents are clearly demo identities (`sim-resident-N`): zero RF, no patrons,
 * no badges, no seasonal Representative, so monuments, Capital, Crown and every player
 * counter are unaffected. The whole click is one pure state transition with ONE summary
 * District Radio entry (no per-resident spam).
 */
export const SIMULATED_RESIDENT_PREFIX = 'sim-resident-'
/** Safety bound for a single click (far above any real ward capacity). */
const MAX_PER_CLICK = 5_000

export function isSimulatedResident(userId: string): boolean {
  return userId.startsWith(SIMULATED_RESIDENT_PREFIX)
}

export interface GrowthResult extends ActionResult {
  /** Simulated residents activated by this click. */
  added: number
  /** Index of the ward that opened (0-based), or null on failure. */
  openedWard: number | null
}

export function simulateDistrictGrowth(state: GameState, districtId: DistrictId): GrowthResult {
  const buildings: Record<string, Building> = { ...state.buildings }
  const users: Record<string, DemoUser> = { ...state.users }
  const counters = { ...state.counters }
  const badges = { ...state.badges }
  const clock = state.clock + 1
  let wards = state.wards
  let seq = state.residentSeq
  let added = 0
  let openedWard: number | null = null

  while (added < MAX_PER_CLICK) {
    const alloc = allocatePlot({ buildings, wards }, districtId)
    if (!alloc) break
    seq += 1
    added += 1
    const friendId = 20_000 + seq
    const userId = `${SIMULATED_RESIDENT_PREFIX}${seq}`
    users[userId] = { id: userId, handle: `sim-resident-${seq}`, friendId, hue: (seq * 67) % 360 }
    counters[userId] = { ...EMPTY_COUNTERS }
    badges[userId] = []
    const b = newBuilding({ friendId, ownerId: userId, address: alloc.address, clock })
    buildings[b.id] = b
    wards = alloc.wards
    if (alloc.openedWard) {
      openedWard = alloc.address.ward
      break
    }
  }
  if (openedWard === null) return { state, events: [], error: 'Growth simulation could not open a new ward', added: 0, openedWard: null }

  const title = districtTitle(districtId)
  const summary: RadioEntry = {
    id: '',
    clock,
    kind: 'growth',
    headline: `${title.toUpperCase()} · ${wardName(openedWard).toUpperCase()} OPENED`,
    detail: `Demo simulation · ${added} simulated Friend${added === 1 ? '' : 's'} activated through the plot allocator · the city expands outward.`,
    districtId,
    buildingId: null,
  }
  return {
    state: { ...state, clock, buildings, users, counters, badges, wards, residentSeq: seq, radio: appendRadio(state.radio, [summary]) },
    events: [{ type: 'ward-opened', districtId, ward: openedWard, simulatedResidents: added }],
    added,
    openedWard,
  }
}
