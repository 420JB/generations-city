import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../config/districts'
import { WORLD } from '../config/world'
import { contribute, findBuildingByFriend, joinCity } from './actions'
import { allocatePlot, districtGrowth, findAvailablePlot, initialWards, newBuilding, wardName } from './allocation'
import type { Building } from './types'
import { districtTierCounts } from './competition'
import { createSeedState, buildingIdFor, SCENARIO } from './seed'
import { cityRadius, districtAngle, plotId, plotPolar, plotWorld, wardBand, wardCapacity } from './world'
import { DEMO_PLAYER_ID } from '../config/identity'

describe('world geometry', () => {
  it('wards grow outward and hold more plots the farther out they are', () => {
    expect(wardBand(0).outer).toBe(WORLD.coreWard.outer)
    expect(wardBand(1).inner).toBe(WORLD.coreWard.outer)
    expect(wardBand(2).inner).toBe(wardBand(1).outer)
    expect(wardCapacity(0)).toBe(21)
    for (let w = 1; w < 25; w++) expect(wardCapacity(w)).toBeGreaterThan(wardCapacity(w - 1))
  })
  it('plots in a district never overlap and stay inside the wedge', () => {
    for (const d of DISTRICT_IDS) {
      const pts = []
      for (let w = 0; w < 3; w++) for (let p = 0; p < wardCapacity(w); p++) pts.push(plotWorld(d, w, p))
      for (let i = 0; i < pts.length; i++) {
        // Widest lot is 2 x (1.12 + 0.7) = 3.64 units, so centres must stay farther apart.
        for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(4.5)
        const ang = (Math.atan2(pts[i].y, pts[i].x) * 180) / Math.PI
        const diff = ((ang - districtAngle(d) + 540) % 360) - 180
        expect(Math.abs(diff)).toBeLessThan(WORLD.districtSpanDeg / 2)
      }
    }
  })
  it('plots never intrude on the civic square', () => {
    for (let p = 0; p < wardCapacity(0); p++) expect(plotPolar(0, p).r).toBeGreaterThan(WORLD.civicSquare.outer + 2)
  })
  it('Ward V and Ward XX are generated procedurally with no special cases', () => {
    const w5 = wardBand(4)
    const w20 = wardBand(19)
    expect(w5.inner).toBe(WORLD.coreWard.outer + 3 * WORLD.wardDepth)
    expect(w20.inner).toBe(WORLD.coreWard.outer + 18 * WORLD.wardDepth)
    expect(wardName(4)).toBe('Ward V')
    expect(wardName(19)).toBe('Ward XX')
    expect(wardName(99)).toBe('Ward C')
    for (const ward of [4, 19]) {
      const band = wardBand(ward)
      const cap = wardCapacity(ward)
      expect(cap).toBeGreaterThan(wardCapacity(0) * (ward === 19 ? 5 : 2))
      const pts = Array.from({ length: cap }, (_, p) => plotPolar(ward, p))
      for (const p of pts) {
        expect(p.r).toBeGreaterThan(band.inner)
        expect(p.r).toBeLessThan(band.outer)
      }
      const world = pts.map((_, p) => plotWorld('d6', ward, p))
      for (let i = 1; i < world.length; i++) expect(Math.hypot(world[i].x - world[i - 1].x, world[i].y - world[i - 1].y)).toBeGreaterThan(4.5)
      expect(() => plotPolar(ward, cap)).toThrow()
    }
  })
  it('plot ids and positions are deterministic', () => {
    expect(plotId('d4', 19, 7)).toBe('d4-w19-p7')
    expect(plotWorld('d4', 19, 7)).toEqual(plotWorld('d4', 19, 7))
    expect(plotId('d4', 0, 0)).not.toBe(plotId('d5', 0, 0))
  })
  it('city radius follows the outermost open ward', () => {
    const w = initialWards()
    expect(cityRadius(w)).toBe(WORLD.coreWard.outer)
    expect(cityRadius({ ...w, d4: 3 })).toBe(wardBand(2).outer)
    expect(cityRadius({ ...w, d4: 20 })).toBe(wardBand(19).outer)
  })
})

describe('plot allocation', () => {
  it('finds the first free plot in the lowest open ward', () => {
    const s = createSeedState()
    // District 1: 6 founders + 14 residents in a 21-plot Founding Ward -> one plot left.
    expect(findAvailablePlot(s, 'd1')).toEqual({ districtId: 'd1', ward: 0, plot: 19 })
    // District 4 is full.
    expect(findAvailablePlot(s, 'd4')).toBeNull()
  })
  it('opens the next ward when capacity is reached', () => {
    const s = createSeedState()
    const a = allocatePlot(s, 'd4')!
    expect(a.openedWard).toBe(true)
    expect(a.address).toEqual({ districtId: 'd4', ward: 1, plot: 0 })
    expect(a.wards.d4).toBe(2)
    expect(s.wards.d4).toBe(1)
  })
  it('has no fixed ward cap: fills 19 wards and opens Ward XX automatically', () => {
    const buildings: Record<string, Building> = {}
    let n = 0
    for (let ward = 0; ward < 19; ward++)
      for (let plot = 0; plot < wardCapacity(ward); plot++) {
        const b = newBuilding({ friendId: 900_000 + n++, ownerId: 'x', address: { districtId: 'd6', ward, plot }, clock: 0 })
        buildings[b.id] = b
      }
    const wards = { ...initialWards(), d6: 19 }
    expect(findAvailablePlot({ buildings, wards }, 'd6')).toBeNull()
    const a = allocatePlot({ buildings, wards }, 'd6')!
    expect(a.openedWard).toBe(true)
    expect(a.address).toEqual({ districtId: 'd6', ward: 19, plot: 0 })
    expect(a.wards.d6).toBe(20)
    // An explicit safety cap is still available to callers that want one.
    expect(allocatePlot({ buildings, wards }, 'd6', 19)).toBeNull()
  })
  it('joinCity creates a Tier 0 property, opens wards deterministically and announces it', () => {
    let s = createSeedState()
    const r = joinCity(s, 'd4')
    expect(r.error).toBeUndefined()
    expect(r.events.map((e) => e.type)).toEqual(['ward-opened', 'resident-joined'])
    s = r.state
    const b = s.buildings['b-20001']
    expect(b).toMatchObject({ districtId: 'd4', ward: 1, plot: 0, ownerBuilt: 0 })
    expect(s.users[b.ownerId]).toBeDefined()
    expect(s.radio[0].headline).toMatch(/OPENS WARD II/)
    // Fill ward II, then the next join opens ward III (and so on, with no limit).
    for (let i = 1; i < wardCapacity(1); i++) s = joinCity(s, 'd4').state
    expect(districtGrowth(s, 'd4').wards[1]).toEqual({ ward: 1, population: wardCapacity(1), capacity: wardCapacity(1) })
    const r3 = joinCity(s, 'd4')
    expect(r3.events[0]).toEqual({ type: 'ward-opened', districtId: 'd4', ward: 2 })
    expect(JSON.stringify(joinCity(createSeedState(), 'd4').state)).toBe(JSON.stringify(joinCity(createSeedState(), 'd4').state))
    expect(wardName(2)).toBe('Ward III')
  })
  it('new residents join the economy and count toward cumulative district tiers', () => {
    let s = joinCity(createSeedState(), 'd9').state
    const id = 'b-20001'
    const before = districtTierCounts(Object.values(s.buildings)).d9
    s = contribute(s, id, DEMO_PLAYER_ID, 500).state
    const after = districtTierCounts(Object.values(s.buildings)).d9
    expect(after[1]).toBe(before[1] + 1)
    expect(after[2]).toBe(before[2] + 1)
    expect(after[3]).toBe(before[3])
  })
  it('search resolves any Friend to its property', () => {
    const s = createSeedState()
    expect(findBuildingByFriend(s, SCENARIO.kingmakerFriend)?.id).toBe(buildingIdFor(SCENARIO.kingmakerFriend))
    expect(findBuildingByFriend(s, 999_999)).toBeNull()
  })
})
