import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../config/districts'
import { MONUMENTS } from '../config/monuments'
import { joinAtPlot } from './actions'
import { availablePlots, districtGrowth } from './allocation'
import { profileSummary } from './badges'
import { buildBoard, cityHotlist } from './buildBoard'
import { buildingsOf, capitalHolder, computeMonumentHolders, districtStandings, tallestBuilding } from './competition'
import { radioDispatches } from './dispatch'
import { createGenesisState, PRESEASON } from './genesis'
import { checkCityState } from './invariants'
import { homeDistrict, ownedFriends, seasonSignals } from './season'
import { isCityStateShape, STATE_VERSION } from './stateSchema'
import { cityRadius, wardCapacity } from './world'

describe('genesis state', () => {
  it('is deterministic: two calls are deep-equal and share nothing', () => {
    const [a, b] = [createGenesisState(), createGenesisState()]
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a).not.toBe(b)
    for (const key of ['users', 'buildings', 'wallets', 'monuments', 'wards', 'season', 'radio', 'capital'] as const) expect(a[key], key).not.toBe(b[key])
    // Changing one never changes the next.
    a.wards.d4 = 7
    a.radio.push({ id: 'x', clock: 0, kind: 'system', headline: '', detail: '', districtId: null, buildingId: null })
    expect(createGenesisState()).toEqual(b)
  })

  it('is empty: nobody, nothing built, nothing held, no history', () => {
    const s = createGenesisState()
    expect(s.version).toBe(STATE_VERSION)
    expect([s.clock, s.residentSeq, s.rivalCursor]).toEqual([0, 0, 0])
    for (const key of ['users', 'buildings', 'wallets', 'badges', 'counters'] as const) expect(s[key], key).toEqual({})
    for (const key of ['radio', 'alertKeys', 'capitalHistory', 'crownHistory'] as const) expect(s[key], key).toEqual([])
    expect(s.capital).toEqual({ holder: null, sinceClock: 0 })
    expect(s.crown).toEqual({ holder: null, sinceClock: 0 })
    expect(Object.keys(s.monuments)).toEqual(MONUMENTS.map((m) => m.id))
    for (const m of MONUMENTS) {
      expect(s.monuments[m.id]).toEqual({ holder: null, sinceClock: 0 })
      expect(s.monumentHistory[m.id]).toEqual([])
    }
    expect(s.wards).toEqual(Object.fromEntries(DISTRICT_IDS.map((d) => [d, 1])))
    expect(s.season).toEqual({ id: 'preseason', name: 'Preseason', number: 0, representatives: {}, activity: {}, joinedClock: {} })
    expect(PRESEASON).toEqual({ id: 'preseason', name: 'Preseason', number: 0 })
    // Nothing in it is, or mentions, the demo.
    expect(JSON.stringify(s).toLowerCase()).not.toMatch(/demo|simulat|npc|resident-/)
  })

  it('is a valid city state: structurally, deeply, and after a JSON round trip', () => {
    const s = createGenesisState()
    expect(isCityStateShape(s)).toBe(true)
    expect(checkCityState(s)).toEqual([])
    const stored = JSON.parse(JSON.stringify(s)) as unknown
    expect(isCityStateShape(stored)).toBe(true)
    expect(checkCityState(stored)).toEqual([])
    expect(stored).toEqual(s)
  })

  it('is a whole city to every read the app makes of it', () => {
    const s = createGenesisState()
    expect(buildingsOf(s)).toEqual([])
    expect(tallestBuilding([], null)).toBeNull()
    expect(capitalHolder([], null)).toBeNull()
    expect(Object.values(computeMonumentHolders([], {}))).toEqual(MONUMENTS.map(() => null))
    expect(districtStandings(buildingsOf(s), s.capital.holder)).toHaveLength(9)
    expect(cityRadius(s.wards)).toBeGreaterThan(0)
    expect(radioDispatches(s, 'nobody')).toEqual([])
    expect(homeDistrict(s, 'nobody')).toBeNull()
    expect(ownedFriends(s, 'nobody')).toEqual([])
    expect(profileSummary(s, 'nobody')).toBeTruthy()
    expect(cityHotlist(s)).toEqual([])
    expect(seasonSignals(s)).toHaveLength(9)
    for (const d of DISTRICT_IDS) {
      expect(districtGrowth(s, d)).toMatchObject({ openWards: 1, population: 0, capacity: wardCapacity(0) })
      // Every founding plot is free, and nothing has to open a second ward to place the first Friend.
      const plots = availablePlots(s, d)
      expect(plots).toHaveLength(wardCapacity(0))
      expect(plots.every((p) => p.ward === 0 && !p.newWard)).toBe(true)
      expect(buildBoard(s, d)).toMatchObject({ districtId: d, closest: [], impact: [] })
    }
  })

  it('accepts a first building through the engine and stays valid', () => {
    const joined = joinAtPlot(createGenesisState(), { districtId: 'd4', ward: 0, plot: 3 })
    expect(joined.error).toBeUndefined()
    expect(Object.keys(joined.state.buildings)).toHaveLength(1)
    expect(checkCityState(joined.state)).toEqual([])
  })
})
