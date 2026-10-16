import { sha256, stringToBytes } from 'viem'
import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { districtForFamily, FAMILY_DISTRICTS } from '../config/familyDistricts'
import { RARE_FRIENDS_FAMILIES } from '../config/rareFriends'
import { allocateSpecificPlot, availablePlots, newBuilding } from '../game/allocation'
import { createGenesisState } from '../game/genesis'
import { createSeedState } from '../game/seed'
import type { GameState } from '../game/types'
import { districtAngle, plotId, plotPolar, plotWorld, wardBand, wardCapacity } from '../game/world'
import { parsePlotId as legacyParsePlotId } from '../protocol/activation'
import { districtOf, nftAsset } from '.'
import { wardBandOf, wardCapacityOf, plotPointOf, plotPolarOf } from './layout'
import { availablePlotsIn, choosePlot, formatPlotId, parsePlotId, resolvePlot } from './plots'
import { worldProperty, worldPropertyIdPreimage } from './property'
import { legacyOccupancy, RARE_CITY_WORLD, RARE_CITY_WORLD_DEFINITION, rareFriendAsset } from './rareCity'

/**
 * The generic engine, given the Rare Friends fixture, must agree with the legacy engine
 * exactly: same districts, same geometry to the last bit, same plot ids, same availability,
 * same property ids. Expected values come from the legacy code itself or from the frozen
 * golden vectors in `legacyGolden.test.ts` and `server/tests/activation.unit.test.ts`.
 */
const sha = (text: string) => sha256(stringToBytes(text)).slice(2)
const district = (key: string) => districtOf(RARE_CITY_WORLD, key)!

/** Small deterministic PRNG (mulberry32), so the randomized equivalence runs are reproducible. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('Rare Friends fixture: districts', () => {
  it('has the nine legacy districts in legacy order, at the legacy angles', () => {
    expect(RARE_CITY_WORLD.id).toBe('rare-city')
    expect(RARE_CITY_WORLD.districts.map((d) => d.key)).toEqual(DISTRICT_IDS)
    for (const d of RARE_CITY_WORLD.districts) expect(d.centerDeg).toBe(districtAngle(d.key as DistrictId))
    expect(RARE_CITY_WORLD.layout.maxWards).toBeNull()
    expect(RARE_CITY_WORLD.buildingIds).toBe('token-v1')
  })

  it('every family lives in a district of the fixture, exactly as the permanent table says', () => {
    RARE_FRIENDS_FAMILIES.forEach((_, family) => expect(districtOf(RARE_CITY_WORLD, districtForFamily(family))?.key).toBe(FAMILY_DISTRICTS[family]))
    expect([...FAMILY_DISTRICTS].sort()).toEqual(RARE_CITY_WORLD.districts.map((d) => d.key).sort())
  })
})

describe('Rare Friends fixture: geometry is bit-identical', () => {
  it('ward bands and capacities, wards 0..60, in every district', () => {
    for (let w = 0; w <= 60; w++) {
      expect(wardBandOf(RARE_CITY_WORLD, w)).toEqual(wardBand(w))
      for (const d of DISTRICT_IDS) expect(wardCapacityOf(RARE_CITY_WORLD, district(d), w)).toBe(wardCapacity(w))
    }
  })

  it('every plot of wards 0..5 and of two deep wards: same polar address and same position', () => {
    for (const d of DISTRICT_IDS)
      for (const w of [0, 1, 2, 3, 4, 5, 19, 40])
        for (let p = 0; p < wardCapacity(w); p++) {
          expect(plotPolarOf(RARE_CITY_WORLD, district(d), w, p)).toEqual(plotPolar(w, p))
          expect(plotPointOf(RARE_CITY_WORLD, district(d), w, p)).toEqual(plotWorld(d, w, p))
        }
  })

  it('reproduces the legacy geometry golden digest', () => {
    const all: unknown[] = []
    for (const d of RARE_CITY_WORLD.districts) for (let w = 0; w < 6; w++) for (let p = 0; p < wardCapacityOf(RARE_CITY_WORLD, d, w); p++) {
      const pt = plotPointOf(RARE_CITY_WORLD, d, w, p)
      all.push([formatPlotId(d.key, w, p), pt.x, pt.y])
    }
    expect(sha(JSON.stringify(all))).toBe('f06897bbc126743a61ee59a8b4b9f46cf9a7412dfe2a68267d59e420b4c9b637')
  })

  it('a plot beyond a ward is refused by both', () => {
    expect(() => plotPolarOf(RARE_CITY_WORLD, district('d4'), 0, 21)).toThrow()
    expect(() => plotPolar(0, 21)).toThrow()
  })
})

describe('Rare Friends fixture: plot identity', () => {
  it('spells plot ids exactly as the legacy engine does', () => {
    for (const d of DISTRICT_IDS) for (const [w, p] of [[0, 0], [0, 20], [19, 7], [999_999, 999_999]]) expect(formatPlotId(d, w, p)).toBe(plotId(d, w, p))
  })

  it('accepts exactly the legacy plot ids (syntax plus a known district) on a corpus of good and bad text', () => {
    const corpus = ['d4-w0-p7', 'd1-w0-p0', 'd9-w999999-p999999', 'd0-w0-p0', 'd10-w0-p0', 'D4-w0-p7', 'd4-w00-p7', 'd4-w0-p07', 'd4-w-1-p0', 'd4-w1000000-p0', 'd4-w0-p1000000', 'd4-w0-p7 ', ' d4-w0-p7', 'd4-w0', 'd4w0p7', 'd4-W0-P7', 'd4-w1.5-p0', '', 'north-w0-p0', 'd4-x-w0-p0']
    for (const text of corpus) {
      const legacy = legacyParsePlotId(text)
      const generic = parsePlotId(text)
      const inWorld = generic && districtOf(RARE_CITY_WORLD, generic.districtKey) ? generic : null
      expect(inWorld === null, text).toBe(legacy === null)
      if (legacy && inWorld) expect({ districtKey: legacy.districtId, ward: legacy.ward, plot: legacy.plot, plotId: legacy.plotId }).toEqual(inWorld)
    }
    for (const bad of [null, undefined, 47, {}, ['d4-w0-p7']]) expect(parsePlotId(bad)).toBeNull()
  })

  it('resolves a plot only where the legacy geometry has one', () => {
    expect(resolvePlot(RARE_CITY_WORLD, 'd4-w0-p20')).not.toBeNull()
    expect(resolvePlot(RARE_CITY_WORLD, 'd4-w0-p21')).toBeNull()
    expect(resolvePlot(RARE_CITY_WORLD, `d4-w40-p${wardCapacity(40) - 1}`)).not.toBeNull()
    expect(resolvePlot(RARE_CITY_WORLD, `d4-w40-p${wardCapacity(40)}`)).toBeNull()
  })
})

describe('Rare Friends fixture: availability and plot choice match the legacy allocator', () => {
  const compare = (state: GameState) => {
    const occupancy = legacyOccupancy(state)
    for (const d of DISTRICT_IDS) {
      const legacy = availablePlots(state, d).map((c) => ({ districtKey: c.districtId, ward: c.ward, plot: c.plot, plotId: plotId(c.districtId, c.ward, c.plot), newWard: c.newWard }))
      expect(availablePlotsIn(RARE_CITY_WORLD, occupancy, d)).toEqual(legacy)
    }
  }

  it('on genesis and on the demo seed city', () => {
    compare(createGenesisState())
    compare(createSeedState())
  })

  it('on 600 randomized placements across every district, through two ward openings', () => {
    const rand = prng(0x5a2a)
    let state: GameState = createGenesisState()
    // Weighted towards three districts so they fill and open new wards.
    const pickDistrict = (): DistrictId => (rand() < 0.75 ? (['d2', 'd4', 'd7'] as const)[Math.floor(rand() * 3)] : DISTRICT_IDS[Math.floor(rand() * 9)])
    for (let i = 0; i < 600; i++) {
      const d = pickDistrict()
      const candidates = availablePlots(state, d)
      const pick = candidates[Math.floor(rand() * candidates.length)]
      const address = { districtId: d, ward: pick.ward, plot: pick.plot }
      const legacy = allocateSpecificPlot(state, address)!
      const generic = choosePlot(RARE_CITY_WORLD, legacyOccupancy(state), plotId(d, pick.ward, pick.plot))
      expect(generic).toEqual({ ok: true, plot: { districtKey: d, ward: pick.ward, plot: pick.plot, plotId: plotId(d, pick.ward, pick.plot) }, openedWard: legacy.openedWard, openWards: legacy.wards[d] })
      const b = newBuilding({ friendId: 10_000 + i, ownerId: 'u', address, clock: 0 })
      state = { ...state, wards: legacy.wards, buildings: { ...state.buildings, [b.id]: b } }
      if (i % 50 === 0) compare(state)
    }
    compare(state)
    expect(Math.max(...Object.values(state.wards))).toBeGreaterThanOrEqual(3)
  })

  it('refuses exactly what the legacy allocator refuses', () => {
    let state: GameState = createGenesisState()
    const b = newBuilding({ friendId: 1, ownerId: 'u', address: { districtId: 'd4', ward: 0, plot: 7 }, clock: 0 })
    state = { ...state, buildings: { [b.id]: b } }
    const occupancy = legacyOccupancy(state)
    for (const [ward, plot] of [[0, 7], [1, 0], [0, 21], [2, 0], [999_999, 0]]) {
      const legacy = allocateSpecificPlot(state, { districtId: 'd4', ward, plot })
      const generic = choosePlot(RARE_CITY_WORLD, occupancy, plotId('d4', ward, plot))
      expect(generic.ok, `${ward}:${plot}`).toBe(legacy !== null)
    }
    expect(choosePlot(RARE_CITY_WORLD, occupancy, 'd4-w0-p7')).toEqual({ ok: false, reason: 'plot-unavailable' })
    expect(choosePlot(RARE_CITY_WORLD, occupancy, 'd4-w0-p21')).toEqual({ ok: false, reason: 'unknown-plot' })
    expect(choosePlot(RARE_CITY_WORLD, occupancy, 'north-w0-p0')).toEqual({ ok: false, reason: 'unknown-plot' })
  })

  it('reads the legacy state without changing a byte of it', () => {
    const seed = createSeedState()
    const before = JSON.stringify(seed)
    Object.freeze(seed.wards)
    Object.freeze(seed.buildings)
    const occupancy = legacyOccupancy(seed)
    expect(occupancy.occupied.size).toBe(180)
    expect(JSON.stringify(seed)).toBe(before)
    expect(sha(before)).toBe('2c8f197856bca346ee4a8bfbc8634b7d89b9c4055bb1a4127d0065d61411e624')
  })
})

describe('Rare Friends fixture: property and building identity', () => {
  it('reproduces the frozen V1 preimage and property ids', () => {
    // The golden values are those of server/tests/activation.unit.test.ts.
    expect(worldPropertyIdPreimage('rare-city', rareFriendAsset('812')!)).toBe('rare-city:property:v1|world=rare-city|chain=4663|collection=0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d|token=812')
    expect(worldProperty(RARE_CITY_WORLD, rareFriendAsset('812')!)).toMatchObject({ propertyId: '29d2ac0a-1754-8500-acdd-802ba2c51575', buildingId: 'b-812', collection: { key: 'rare-friends-generations' } })
    expect(worldProperty(RARE_CITY_WORLD, rareFriendAsset('0')!)?.propertyId).toBe('abc2fd4d-1222-8e93-9c44-fc0e9206f090')
    expect(worldProperty(RARE_CITY_WORLD, rareFriendAsset('9007199254740991')!)?.propertyId).toBe('3135a130-3e5c-8cb5-97a8-899928b23dd0')
  })

  it('keys buildings b-<friendId>, as newBuilding does', () => {
    for (const token of [0, 812, 4471, 9_007_199_254_740_991]) expect(worldProperty(RARE_CITY_WORLD, rareFriendAsset(String(token))!)?.buildingId).toBe(newBuilding({ friendId: token, ownerId: 'u', address: { districtId: 'd4', ward: 0, plot: 0 }, clock: 0 }).id)
  })

  it('a token #812 of another collection is not a property of the Rare Friends world', () => {
    expect(worldProperty(RARE_CITY_WORLD, nftAsset({ chain: 'eip155:4663', contract: '0x' + '12'.repeat(20), tokenId: '812' })!)).toBeNull()
    expect(worldProperty(RARE_CITY_WORLD, nftAsset({ chain: 'eip155:1', contract: RARE_CITY_WORLD_DEFINITION.collections[0].contract, tokenId: '812' })!)).toBeNull()
  })
})
