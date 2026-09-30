import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../config/districts'
import { DEMO_PLAYER_ID } from '../config/identity'
import { contribute } from './actions'
import { newBuilding } from './allocation'
import { capitalScore, districtTierCounts } from './competition'
import { totalBuilt } from './economy'
import { isSimulatedResident, simulateDistrictGrowth } from './growth'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'
import type { GameState } from './types'
import { wardCapacity } from './world'

const FAMILY = 'd4'

function added(before: GameState, after: GameState) {
  return Object.values(after.buildings).filter((b) => !before.buildings[b.id])
}

function competitiveSnapshot(s: GameState) {
  const counts = districtTierCounts(Object.values(s.buildings))
  return {
    monuments: s.monuments,
    capital: s.capital.holder,
    scores: DISTRICT_IDS.map((d) => capitalScore(counts[d])),
    crown: s.crown.holder,
    playerBadges: s.badges[DEMO_PLAYER_ID],
    playerCounters: s.counters[DEMO_PLAYER_ID],
    wallet: s.wallets[DEMO_PLAYER_ID],
    representatives: s.season.representatives,
  }
}

describe('demo-only district growth simulator', () => {
  it('first click opens exactly one new Family ward and stops at its first property', () => {
    const s0 = createSeedState()
    expect(s0.wards[FAMILY]).toBe(1)
    const r = simulateDistrictGrowth(s0, FAMILY)
    expect(r.error).toBeUndefined()
    expect(r.openedWard).toBe(1)
    expect(r.state.wards[FAMILY]).toBe(2)
    for (const d of DISTRICT_IDS) if (d !== FAMILY) expect(r.state.wards[d]).toBe(s0.wards[d])
    const fresh = added(s0, r.state)
    expect(fresh).toHaveLength(r.added)
    // Seeded Ward I is already full (21/21), so the very first resident opens Ward II.
    expect(r.added).toBe(1)
    // Exactly one property lives in the new ward: the simulation stopped right after opening it.
    expect(fresh.filter((b) => b.ward === 1)).toHaveLength(1)
    expect(Object.values(r.state.buildings).filter((b) => b.districtId === FAMILY && b.ward === 1)).toHaveLength(1)
  })

  it('second click fills Ward II through the allocator and opens Ward III', () => {
    const s1 = simulateDistrictGrowth(createSeedState(), FAMILY).state
    const r = simulateDistrictGrowth(s1, FAMILY)
    expect(r.openedWard).toBe(2)
    expect(r.state.wards[FAMILY]).toBe(3)
    for (const d of DISTRICT_IDS) if (d !== FAMILY) expect(r.state.wards[d]).toBe(1)
    // 32 remaining Ward II plots + the resident who opens Ward III.
    expect(r.added).toBe(wardCapacity(1) - 1 + 1)
    const family = Object.values(r.state.buildings).filter((b) => b.districtId === FAMILY)
    expect(family.filter((b) => b.ward === 1)).toHaveLength(wardCapacity(1))
    expect(family.filter((b) => b.ward === 2)).toHaveLength(1)
    // Every Family plot is unique and inside its ward's capacity.
    const keys = family.map((b) => `${b.ward}:${b.plot}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const b of family) expect(b.plot).toBeLessThan(wardCapacity(b.ward))
    // And it keeps going generically: Ward III → Ward IV.
    expect(simulateDistrictGrowth(r.state, FAMILY).state.wards[FAMILY]).toBe(4)
  })

  it('new properties are ordinary unbuilt newBuilding() properties owned by distinct simulated residents', () => {
    const s0 = createSeedState()
    const s2 = simulateDistrictGrowth(simulateDistrictGrowth(s0, FAMILY).state, FAMILY).state
    const fresh = added(s0, s2)
    for (const b of fresh) {
      expect(b).toEqual(newBuilding({ friendId: b.friendId, ownerId: b.ownerId, address: { districtId: FAMILY, ward: b.ward, plot: b.plot }, clock: 0 }))
      expect(totalBuilt(b)).toBe(0)
      expect(isSimulatedResident(b.ownerId)).toBe(true)
      expect(s2.users[b.ownerId].friendId).toBe(b.friendId)
      expect(s2.badges[b.ownerId]).toEqual([])
      expect(s2.season.representatives[b.ownerId]).toBeUndefined()
    }
    expect(new Set(fresh.map((b) => b.ownerId)).size).toBe(fresh.length)
    expect(fresh.every((b) => b.ownerId !== DEMO_PLAYER_ID)).toBe(true)
  })

  it('leaves monuments, Capital, Crown and the player untouched', () => {
    let s = createSeedState()
    const before = competitiveSnapshot(s)
    s = simulateDistrictGrowth(simulateDistrictGrowth(s, FAMILY).state, FAMILY).state
    expect(competitiveSnapshot(s)).toEqual(before)
    // The judge path still works on a grown city.
    const r = contribute(s, buildingIdFor(SCENARIO.kingmakerFriend), DEMO_PLAYER_ID, 38)
    expect(r.state.monuments.m4.holder).toBe(FAMILY)
  })

  it('writes one summary City Feed entry per click, clearly marked as a simulation', () => {
    const s0 = createSeedState()
    const r = simulateDistrictGrowth(simulateDistrictGrowth(s0, FAMILY).state, FAMILY)
    expect(r.state.radio.length - s0.radio.length).toBe(2)
    expect(r.state.radio[0].headline).toBe('FAMILY DISTRICT · WARD III OPENED')
    expect(r.state.radio[0].detail).toMatch(/Demo simulation · 33 simulated Friends activated/)
    expect(r.events).toEqual([{ type: 'ward-opened', districtId: FAMILY, ward: 2, simulatedResidents: 33 }])
  })

  it('is deterministic, and a reseed (Reset Demo) removes all simulated growth', () => {
    const a = simulateDistrictGrowth(createSeedState(), FAMILY).state
    const b = simulateDistrictGrowth(createSeedState(), FAMILY).state
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const reset = createSeedState()
    expect(reset.wards[FAMILY]).toBe(1)
    expect(Object.keys(reset.users).some(isSimulatedResident)).toBe(false)
    expect(Object.keys(reset.buildings)).toHaveLength(Object.keys(createSeedState().buildings).length)
  })
})
