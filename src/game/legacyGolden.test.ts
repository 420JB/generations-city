import { sha256, stringToBytes } from 'viem'
import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../config/districts'
import { FAMILY_DISTRICTS } from '../config/familyDistricts'
import { parsePlotId } from '../protocol/activation'
import { parseCityResponse } from '../protocol/city'
import { activateFriend } from './activation'
import { allocatePlot, availablePlots, newBuilding } from './allocation'
import { createGenesisState } from './genesis'
import { checkCityState } from './invariants'
import { createSeedState } from './seed'
import { isCityStateShape, STATE_VERSION } from './stateSchema'
import type { GameState } from './types'
import { districtAngle, plotId, plotPolar, plotWorld, wardBand, wardCapacity } from './world'

/**
 * GOLDEN REGRESSION PINS FOR THE LEGACY RARE FRIENDS CITY.
 *
 * Every value below was captured from this code at `ecab94c`, before the generic world
 * engine (`src/world`) existed, and none was worked out by hand. Two of them are also on
 * record outside the code: the genesis hash is the stored state of the staging activation
 * rehearsal city when it was installed, and the seed hash is the stored state of the old
 * staging demo-fixture city.
 *
 * A failure here means the legacy city changed. That is never a refactor: it changes what
 * existing cities, properties or signatures mean.
 *
 * Pinned elsewhere, deliberately not repeated: V1 property ids, ownership era ids and the
 * V1 `PropertyActivation` digest and signature (`server/tests/activation.unit.test.ts`);
 * the family -> district table (`src/config/familyDistricts.test.ts`); the `/v1/city`
 * body (`server/tests/city.http.test.ts`, `src/protocol/city.test.ts`).
 */
const sha = (text: string) => sha256(stringToBytes(text)).slice(2)

describe('legacy state v5 encoding', () => {
  it('is still version 5', () => {
    expect(STATE_VERSION).toBe(5)
  })

  it('GOLDEN: genesis serializes to exactly the stored bytes', () => {
    const text = JSON.stringify(createGenesisState())
    expect(text.length).toBe(701)
    expect(sha(text)).toBe('55da6bc5b9138e6a9903777eeec505d3c561c50f1e044b45f2800a98ab471a7e')
  })

  it('GOLDEN: the demo seed city serializes to exactly the stored bytes, and is sound', () => {
    const seed = createSeedState()
    const text = JSON.stringify(seed)
    expect(text.length).toBe(115_778)
    expect(sha(text)).toBe('2c8f197856bca346ee4a8bfbc8634b7d89b9c4055bb1a4127d0065d61411e624')
    expect(Object.keys(seed.buildings)).toHaveLength(180)
    expect(seed.wards).toEqual(Object.fromEntries(DISTRICT_IDS.map((d) => [d, 1])))
    expect(isCityStateShape(seed)).toBe(true)
    expect(checkCityState(seed)).toEqual([])
  })

  it('GOLDEN: the seed city building ids and their plots', () => {
    const seed = createSeedState()
    expect(sha(JSON.stringify(Object.keys(seed.buildings)))).toBe('51adc3f9146f0d35e70148bc7c1e5b50c558ab2ac532aa2841511f8f1c0b9281')
    expect(sha(JSON.stringify(Object.values(seed.buildings).map((b) => [b.id, plotId(b.districtId, b.ward, b.plot)])))).toBe('efba663778dfb9933f632bb28ee7dc3598934ebdc7d8299d10c3ff9712863eb9')
    // Every building is keyed `b-<friendId>`.
    for (const b of Object.values(seed.buildings)) expect(b.id).toBe(`b-${b.friendId}`)
  })

  it('GOLDEN: one activation on genesis produces exactly this state', () => {
    const userId = '0b9c1f5e-2b51-4c5f-9a43-0e0a0c9f6d11'
    const outcome = activateFriend(createGenesisState(), { userId, ownerAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', tokenId: 812, familyId: 2, address: { districtId: 'd4', ward: 0, plot: 7 } })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.building.id).toBe('b-812')
    expect(outcome.state.users[userId]).toEqual({ id: userId, handle: '0xf39f…2266', friendId: 812, hue: 245 })
    expect(sha(JSON.stringify(outcome.state))).toBe('05a12792cd0e3bcab760f746bb490ecfe9e581a2f2addda5525cf2108056a21f')
  })

  it('GOLDEN: a genesis city snapshot passes the public contract with its state untouched', () => {
    const state = createGenesisState()
    const body = { city: { id: 'main', instance: 'd8fae2d7-7044-4faf-b36c-f4b700c3ba28', sequence: 1, stateVersion: 5, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-03T20:11:00.000Z' }, server: { mode: 'staging' }, state }
    const parsed = parseCityResponse(JSON.parse(JSON.stringify(body)))
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(sha(JSON.stringify(parsed.response.state))).toBe('55da6bc5b9138e6a9903777eeec505d3c561c50f1e044b45f2800a98ab471a7e')
    expect(Object.keys(parsed.response)).toEqual(['city', 'server', 'state'])
  })
})

describe('legacy districts', () => {
  it('are exactly d1..d9, in this order, at these angles', () => {
    expect(DISTRICT_IDS).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'])
    expect(DISTRICT_IDS.map(districtAngle)).toEqual([-135, -95, -55, -15, 25, 65, 105, 145, 185])
  })

  it('family -> district is the permanent table', () => {
    expect(FAMILY_DISTRICTS).toEqual(['d8', 'd6', 'd4', 'd5', 'd7', 'd9', 'd3', 'd2', 'd1'])
  })
})

describe('legacy ward and plot geometry', () => {
  it('GOLDEN: ward capacities 0..20', () => {
    expect(Array.from({ length: 21 }, (_, w) => wardCapacity(w))).toEqual([21, 33, 44, 55, 65, 77, 87, 99, 109, 120, 131, 143, 153, 164, 175, 186, 197, 208, 219, 229, 241])
  })

  it('GOLDEN: ward bands', () => {
    expect([0, 1, 2, 3].map(wardBand)).toEqual([
      { ward: 0, inner: 22, outer: 64 },
      { ward: 1, inner: 64, outer: 88 },
      { ward: 2, inner: 88, outer: 112 },
      { ward: 3, inner: 112, outer: 136 },
    ])
  })

  it('GOLDEN: sample plot positions, to the last bit', () => {
    expect(plotWorld('d4', 0, 7)).toEqual({ x: 48.00414719902776, y: -6.917503284717315 })
    expect(plotWorld('d1', 2, 30)).toEqual({ x: -55.81810389752364, y: -87.15841483921822 })
    expect(plotWorld('d9', 5, 0)).toEqual({ x: -159.97499846953536, y: 31.256997051414835 })
    expect(plotPolar(0, 0)).toEqual({ r: 43, offsetDeg: -12.75 })
    expect(plotPolar(3, 50)).toEqual({ r: 133, offsetDeg: 6.800000000000001 })
  })

  it('GOLDEN: every plot of wards 0..5 in every district, ids and positions', () => {
    const all: unknown[] = []
    for (const d of DISTRICT_IDS) for (let w = 0; w < 6; w++) for (let p = 0; p < wardCapacity(w); p++) {
      const pt = plotWorld(d, w, p)
      all.push([plotId(d, w, p), pt.x, pt.y])
    }
    expect(all).toHaveLength(2_655)
    expect(sha(JSON.stringify(all))).toBe('f06897bbc126743a61ee59a8b4b9f46cf9a7412dfe2a68267d59e420b4c9b637')
  })

  it('plot ids keep their spelling and parse back', () => {
    expect(plotId('d4', 0, 7)).toBe('d4-w0-p7')
    expect(parsePlotId('d4-w0-p7')).toEqual({ districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7' })
    for (const bad of ['d0-w0-p0', 'd10-w0-p0', 'north-w0-p0', 'd4-w00-p0', 'd4-w0-p1000000']) expect(parsePlotId(bad), bad).toBeNull()
  })
})

describe('legacy allocation and ward expansion', () => {
  it('GOLDEN: filling d4 from genesis opens Ward II after 21 and Ward III after 54', () => {
    let state: GameState = createGenesisState()
    const order: string[] = []
    const opened: number[] = []
    for (let i = 0; i < 56; i++) {
      const a = allocatePlot(state, 'd4')
      if (!a) throw new Error('unbounded allocation refused')
      if (a.openedWard) opened.push(i)
      const b = newBuilding({ friendId: 1000 + i, ownerId: 'u', address: a.address, clock: 0 })
      state = { ...state, wards: a.wards, buildings: { ...state.buildings, [b.id]: b } }
      order.push(plotId('d4', a.address.ward, a.address.plot))
    }
    expect(opened).toEqual([21, 54])
    expect(order.slice(0, 3)).toEqual(['d4-w0-p0', 'd4-w0-p1', 'd4-w0-p2'])
    expect(order.slice(20, 23)).toEqual(['d4-w0-p20', 'd4-w1-p0', 'd4-w1-p1'])
    expect(order.slice(-3)).toEqual(['d4-w1-p32', 'd4-w2-p0', 'd4-w2-p1'])
    expect(sha(JSON.stringify(order))).toBe('0dd7c87f2e1cf6745488dfad0007f64df7a18cd76400f21d1bcbd7714793438a')
    expect(state.wards.d4).toBe(3)
  })

  it('GOLDEN: a full founding ward previews exactly the 33 plots of Ward II', () => {
    let state: GameState = createGenesisState()
    for (let p = 0; p < 21; p++) {
      const b = newBuilding({ friendId: p, ownerId: 'u', address: { districtId: 'd2', ward: 0, plot: p }, clock: 0 })
      state = { ...state, buildings: { ...state.buildings, [b.id]: b } }
    }
    const candidates = availablePlots(state, 'd2')
    expect(candidates).toHaveLength(33)
    expect(candidates.every((c) => c.ward === 1 && c.newWard)).toBe(true)
  })

  it('new buildings are keyed by the Friend alone', () => {
    expect(newBuilding({ friendId: 812, ownerId: 'u', address: { districtId: 'd4', ward: 0, plot: 7 }, clock: 0 }).id).toBe('b-812')
  })
})
