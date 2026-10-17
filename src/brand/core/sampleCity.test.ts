import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../../config/districts'
import { MONUMENTS } from '../../config/monuments'
import { capitalHolder, capitalHolderIn, computeMonumentHolders, computeMonumentHoldersIn, districtTierCountsIn } from '../../game/competition'
import { tierFor, totalBuilt } from '../../game/economy'
import { createSeedState } from '../../game/seed'
import { nftAsset } from '../../world/asset'
import { districtOf } from '../../world/definition'
import { wardCapacityOf } from '../../world/layout'
import { availablePlotsIn, choosePlot, formatPlotId, occupancyProblems, resolvePlot } from '../../world/plots'
import { worldProperty } from '../../world/property'
import { loadBrandCity } from '../load'
import { SAMPLE_BRANDS } from '../samples'
import { brandWedge, compileBrandWorld } from './layout'
import { parseBrandCityConfig } from './config'

const load = (i: number) => {
  const r = loadBrandCity(SAMPLE_BRANDS[i].config, SAMPLE_BRANDS[i].city)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.city
}

describe('standard layout for a brand', () => {
  it('splits the full turn evenly, District 1 at the back, wedges touching and never overlapping', () => {
    for (const n of [3, 4, 6, 9]) {
      const w = Array.from({ length: n }, (_, i) => brandWedge(i, n))
      expect(w[0].centerDeg).toBe(-135)
      expect(w.reduce((a, x) => a + x.spanDeg, 0)).toBeCloseTo(360, 9)
      for (let i = 1; i < n; i++) expect(w[i].centerDeg - w[i - 1].centerDeg).toBeCloseTo(360 / n, 9)
    }
  })

  it('compiles through the generic engine with exactly the configured districts and collections', () => {
    for (const [i, n, c] of [[0, 4, 2], [1, 6, 3]] as const) {
      const parsed = parseBrandCityConfig(SAMPLE_BRANDS[i].config)
      if (!parsed.ok) throw new Error('parse')
      const compiled = compileBrandWorld(parsed.config)
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) continue
      expect(compiled.world.districts.map((d) => d.key)).toEqual(parsed.config.districts.map((d) => d.key))
      expect(compiled.world.districts).toHaveLength(n)
      expect(compiled.world.collections).toHaveLength(c)
      expect(compiled.world.buildingIds).toBe('property-v1')
    }
  })
})

describe('simulated sample cities', () => {
  for (const i of [0, 1]) {
    it(`brand ${i}: every building stands on its own real plot, in an open ward, with its V2 property id`, () => {
      const city = load(i)
      const { world, state } = city
      const plots = Object.values(state.buildings).map((b) => formatPlotId(b.districtId, b.ward, b.plot))
      expect(new Set(plots).size).toBe(plots.length)
      for (const id of plots) expect(resolvePlot(world, id)).not.toBeNull()
      expect(occupancyProblems(world, { openWards: state.wards, occupied: new Set(plots) })).toEqual([])
      for (const b of Object.values(state.buildings)) {
        const nft = state.nfts[b.id]
        const c = city.config.collections.find((x) => x.key === nft.collection)!
        const property = worldProperty(world, nftAsset({ chain: c.chain, contract: c.contract, tokenId: nft.tokenId })!)!
        expect(b.id).toBe(property.buildingId)
        expect(property.propertyIdVersion).toBe('v2')
      }
      // A second ward is open only where the first is full.
      for (const d of world.districts) {
        const open = state.wards[d.key]
        if (open > 1) expect(plots.filter((p) => p.startsWith(`${d.key}-w0-`))).toHaveLength(wardCapacityOf(world, districtOf(world, d.key)!, 0))
      }
    })

    it(`brand ${i}: replaying every resident in join order through the engine reproduces the city exactly`, () => {
      // Each resident's plot must be one the engine offered at the moment they joined: never in an
      // unopened ward, never in a new ward while an open ward still had room.
      const { world, state } = load(i)
      const occupancy = { openWards: {} as Record<string, number>, occupied: new Set<string>() }
      for (const b of Object.values(state.buildings)) {
        const offered = availablePlotsIn(world, occupancy, b.districtId)!
        const plotId = formatPlotId(b.districtId, b.ward, b.plot)
        const pick = offered.find((c) => c.plotId === plotId)
        expect(pick, `${plotId} was not on offer when its resident joined`).toBeDefined()
        if (pick!.newWard) expect(offered.every((c) => c.newWard), `${plotId} opened a ward while an open ward had room`).toBe(true)
        const choice = choosePlot(world, occupancy, plotId)
        if (!choice.ok) throw new Error(choice.reason)
        occupancy.occupied.add(plotId)
        occupancy.openWards[b.districtId] = choice.openWards
      }
      for (const d of world.districts) expect(occupancy.openWards[d.key] ?? 1).toBe(state.wards[d.key])
    })

    it(`brand ${i}: a ward that has filled and been superseded holds no bare foundations`, () => {
      const { state } = load(i)
      for (const b of Object.values(state.buildings))
        if (b.ward < state.wards[b.districtId] - 1) expect(tierFor(totalBuilt(b)), `${b.districtId} ward ${b.ward} plot ${b.plot}`).toBeGreaterThan(0)
    })

    it(`brand ${i}: holders follow the standard competition rules`, () => {
      const { config, state } = load(i)
      const keys = config.districts.map((d) => d.key)
      const counts = districtTierCountsIn(keys, Object.values(state.buildings))
      for (const m of MONUMENTS) {
        const holder = state.monuments[m.id].holder
        const best = Math.max(...keys.map((k) => counts[k][m.tier]))
        if (best === 0) expect(holder).toBeNull()
        else expect(counts[holder!][m.tier]).toBe(best)
      }
      expect(state.capital.holder).toBe(capitalHolderIn(keys, Object.values(state.buildings), null))
    })

    it(`brand ${i}: is deterministic and its token numbers never collide`, () => {
      const a = load(i)
      const b = load(i)
      expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
      const friendIds = Object.values(a.state.buildings).map((x) => x.friendId)
      expect(new Set(friendIds).size).toBe(friendIds.length)
    })
  }

  it('each brand has a district that expanded into Ward II through the engine, at the same density', () => {
    const counts = [0, 1].map((i) => {
      const { world, state } = load(i)
      const expanded = world.districts.filter((d) => state.wards[d.key] === 2)
      expect(expanded).toHaveLength(1)
      const d = expanded[0]
      const inWard = (w: number) => Object.values(state.buildings).filter((b) => b.districtId === d.key && b.ward === w).length
      expect(inWard(0)).toBe(wardCapacityOf(world, d, 0))
      expect(inWard(1)).toBe(i === 0 ? 4 : 3)
      return Object.keys(state.buildings).length
    })
    expect(counts).toEqual([171, 158])
  })

  it('an opened ward may regain an empty plot; it is offered again and taking it opens nothing', () => {
    const { world, state } = load(0)
    const occupied = new Set(Object.values(state.buildings).map((b) => formatPlotId(b.districtId, b.ward, b.plot)))
    const vacated = formatPlotId('saltmarsh', 0, 3)
    expect(occupied.delete(vacated)).toBe(true)
    const occupancy = { openWards: state.wards, occupied }
    expect(occupancyProblems(world, occupancy)).toEqual([])
    const offered = availablePlotsIn(world, occupancy, 'saltmarsh')!
    expect(offered.some((c) => c.plotId === vacated)).toBe(true)
    expect(offered.every((c) => c.ward < 2 && !c.newWard)).toBe(true)
    const choice = choosePlot(world, occupancy, vacated)
    expect(choice).toMatchObject({ ok: true, openedWard: false, openWards: 2 })
  })

  it('a preview never opens a ward: offering and checking plots leave the occupancy untouched', () => {
    const { world, state } = load(0)
    const occupied = new Set(Object.values(state.buildings).map((b) => formatPlotId(b.districtId, b.ward, b.plot)))
    const openWards = { ...state.wards }
    // Saltmarsh's Ward II has room, so nothing in Ward III is offered or choosable.
    expect(availablePlotsIn(world, { openWards, occupied }, 'saltmarsh')!.every((c) => c.ward <= 1)).toBe(true)
    expect(choosePlot(world, { openWards, occupied }, formatPlotId('saltmarsh', 2, 0))).toEqual({ ok: false, reason: 'plot-unavailable' })
    expect(openWards).toEqual(state.wards)
    expect(occupied.size).toBe(Object.keys(state.buildings).length)
  })

  it('the district-list rules are the legacy rules, exactly, for the nine legacy districts', () => {
    const seed = createSeedState()
    const list = Object.values(seed.buildings)
    expect(computeMonumentHoldersIn(DISTRICT_IDS, list, {})).toEqual(computeMonumentHolders(list, {}))
    expect(capitalHolderIn(DISTRICT_IDS, list, null)).toBe(capitalHolder(list, null))
  })
})
