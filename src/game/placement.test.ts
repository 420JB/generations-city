import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { joinAtPlot, joinCity } from './actions'
import { allocatePlot, availablePlots, findAvailablePlot } from './allocation'
import { simulateDistrictGrowth } from './growth'
import { createSeedState } from './seed'
import type { GameState } from './types'
import { wardCapacity } from './world'

const occupied = (s: GameState, d: DistrictId) => new Set(Object.values(s.buildings).filter((b) => b.districtId === d).map((b) => `${b.ward}:${b.plot}`))

describe('explicit plot placement', () => {
  it('lists every free plot in the open wards and never an occupied one', () => {
    const s = createSeedState()
    for (const d of DISTRICT_IDS) {
      const used = occupied(s, d)
      const c = availablePlots(s, d)
      const free = wardCapacity(0) - used.size
      if (free > 0) {
        expect(c).toHaveLength(free)
        expect(c.every((p) => p.ward === 0 && !p.newWard && !used.has(`${p.ward}:${p.plot}`))).toBe(true)
      }
    }
    // After Family opens Ward II (1 resident), every remaining Ward II plot is a candidate.
    const grown = simulateDistrictGrowth(s, 'd4').state
    const c = availablePlots(grown, 'd4')
    expect(c).toHaveLength(wardCapacity(1) - 1)
    expect(c.every((p) => p.ward === 1 && !p.newWard)).toBe(true)
  })

  it('places the Friend on exactly the chosen plot, even when it is not the first free one', () => {
    const s = simulateDistrictGrowth(createSeedState(), 'd4').state // Family Ward II: plot 0 taken
    const first = findAvailablePlot(s, 'd4')!
    expect(first).toEqual({ districtId: 'd4', ward: 1, plot: 1 })
    const r = joinAtPlot(s, { districtId: 'd4', ward: 1, plot: 17 })
    expect(r.error).toBeUndefined()
    const b = r.state.buildings[`b-${20_000 + s.residentSeq + 1}`]
    expect(b).toMatchObject({ districtId: 'd4', ward: 1, plot: 17 })
    expect(availablePlots(r.state, 'd4').some((p) => p.ward === 1 && p.plot === 1)).toBe(true)
  })

  it('rejects other districts, occupied plots, invalid indexes and closed future wards', () => {
    const s = simulateDistrictGrowth(createSeedState(), 'd4').state // Family: Ward II open, 32 free
    const taken = Object.values(s.buildings).find((b) => b.districtId === 'd4')!
    expect(joinAtPlot(s, { districtId: 'd4', ward: taken.ward, plot: taken.plot }).error).toMatch(/not available/)
    expect(joinAtPlot(s, { districtId: 'd4', ward: 1, plot: wardCapacity(1) }).error).toMatch(/not available/)
    expect(joinAtPlot(s, { districtId: 'd4', ward: 1, plot: -1 }).error).toMatch(/not available/)
    expect(joinAtPlot(s, { districtId: 'd4', ward: 1, plot: 2.5 }).error).toMatch(/not available/)
    // Ward III is closed while Ward II still has room.
    expect(joinAtPlot(s, { districtId: 'd4', ward: 2, plot: 0 }).error).toMatch(/not available/)
    expect(joinAtPlot(s, { districtId: 'd4', ward: 7, plot: 0 }).error).toMatch(/not available/)
    // A plot address for another district's ward that is closed there.
    expect(joinAtPlot(s, { districtId: 'd1', ward: 1, plot: 0 }).error).toMatch(/not available/)
    expect(joinAtPlot(s, { districtId: 'dx' as DistrictId, ward: 0, plot: 0 }).error).toMatch(/not available/)
    // Failures return the untouched state.
    expect(joinAtPlot(s, { districtId: 'd4', ward: 2, plot: 0 }).state).toBe(s)
  })

  it('a full district previews the next ward as candidates without mutating state', () => {
    const s = createSeedState() // Family Ward I is 21/21
    const before = JSON.stringify(s)
    const c = availablePlots(s, 'd4')
    expect(c).toHaveLength(wardCapacity(1))
    expect(c.every((p) => p.ward === 1 && p.newWard)).toBe(true)
    expect(JSON.stringify(s)).toBe(before)
    expect(s.wards.d4).toBe(1)
  })

  it('confirming a next-ward plot opens the ward atomically with the join', () => {
    const s = createSeedState()
    const r = joinAtPlot(s, { districtId: 'd4', ward: 1, plot: 12 })
    expect(r.error).toBeUndefined()
    expect(r.state.wards.d4).toBe(2)
    for (const d of DISTRICT_IDS) if (d !== 'd4') expect(r.state.wards[d]).toBe(s.wards[d])
    expect(r.events).toEqual([
      { type: 'ward-opened', districtId: 'd4', ward: 1 },
      { type: 'resident-joined', buildingId: 'b-20001', districtId: 'd4', ward: 1, plot: 12 },
    ])
    expect(r.state.buildings['b-20001']).toMatchObject({ districtId: 'd4', ward: 1, plot: 12, ownerBuilt: 0 })
    // City Feed gets the expansion once (plus the move-in line), not per plot.
    expect(r.state.radio.length - s.radio.length).toBe(2)
  })

  it('resident / Friend ids advance only on a confirmed join', () => {
    const s = createSeedState()
    availablePlots(s, 'd1')
    availablePlots(s, 'd4')
    joinAtPlot(s, { districtId: 'd4', ward: 5, plot: 0 }) // rejected
    expect(s.residentSeq).toBe(0)
    const ok = joinAtPlot(s, { districtId: 'd4', ward: 1, plot: 3 }).state
    expect(ok.residentSeq).toBe(1)
    expect(ok.buildings['b-20001']).toBeDefined()
    expect(joinAtPlot(ok, { districtId: 'd4', ward: 1, plot: 4 }).state.buildings['b-20002']).toBeDefined()
  })

  it('shares the auto-join path: the same address gives the same result as joinCity', () => {
    const s = createSeedState()
    const auto = joinCity(s, 'd1')
    const a = findAvailablePlot(s, 'd1')!
    const explicit = joinAtPlot(s, a)
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(auto))
  })

  it('leaves the deterministic auto allocator and capacities unchanged', () => {
    const s = createSeedState()
    expect(allocatePlot(s, 'd4')).toEqual({ address: { districtId: 'd4', ward: 1, plot: 0 }, openedWard: true, wards: { ...s.wards, d4: 2 } })
    expect([0, 1, 2].map(wardCapacity)).toEqual([21, 33, 44])
    const g = simulateDistrictGrowth(simulateDistrictGrowth(s, 'd4').state, 'd4')
    expect(g.added).toBe(33)
    expect(g.state.wards.d4).toBe(3)
  })
})
