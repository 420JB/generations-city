import { describe, expect, it } from 'vitest'
import { joinAtPlot, joinCity } from './actions'
import { newBuilding } from './allocation'
import { createGenesisState } from './genesis'
import { simulateDistrictGrowth } from './growth'
import { checkAuthoritativeCity, checkCityState, checkPropertyParity, cityMode, isActivatable, type CityFlags, type PropertyFacts } from './invariants'
import { createSeedState } from './seed'
import type { GameState } from './types'
import { wardCapacity } from './world'

const CANONICAL: CityFlags = { canonical: true, origin: 'genesis', activationRehearsal: false }
const REHEARSAL: CityFlags = { canonical: false, origin: 'demo-fixture', activationRehearsal: true }
const FIXTURE: CityFlags = { canonical: false, origin: 'demo-fixture', activationRehearsal: false }

/** A property and its building, as a real activation would create them. */
function activated(state: GameState, tokenId: number, familyId: number, districtId: 'd4' | 'd9' | 'd2', ward: number, plot: number): PropertyFacts {
  const ownerId = `user-${tokenId}`
  state.users[ownerId] = { id: ownerId, handle: `0x${tokenId}`, friendId: tokenId, hue: 10 }
  const b = newBuilding({ friendId: tokenId, ownerId, address: { districtId, ward, plot }, clock: 1 })
  state.buildings[b.id] = b
  return { propertyId: `p-${tokenId}`, tokenId: String(tokenId), familyId, districtId, ward, plot, plotId: `${districtId}-w${ward}-p${plot}`, buildingId: b.id }
}
/** An empty city with three properties in it, and the rows that describe them. */
function activatedCity() {
  const state = createGenesisState()
  const properties = [activated(state, 812, 2, 'd4', 0, 3), activated(state, 77, 5, 'd9', 0, 0), activated(state, 4471, 7, 'd2', 0, 11)]
  return { state, properties }
}
const rules = (violations: { rule: string }[]) => [...new Set(violations.map((v) => v.rule))].sort()
const categories = (violations: { category: string }[]) => [...new Set(violations.map((v) => v.category))].sort()
/** The violations a change to an otherwise valid activated city produces. */
function after(change: (s: GameState) => void) {
  const { state } = activatedCity()
  change(state)
  return checkCityState(state)
}

describe('city mode', () => {
  it('knows exactly three kinds of city', () => {
    expect(cityMode(CANONICAL)).toBe('canonical')
    expect(cityMode(REHEARSAL)).toBe('rehearsal')
    expect(cityMode(FIXTURE)).toBe('demo-fixture')
    expect([isActivatable('canonical'), isActivatable('rehearsal'), isActivatable('demo-fixture')]).toEqual([true, true, false])
  })

  it('never accepts any other combination, or a flag it cannot read', () => {
    const unknown: CityFlags[] = [
      { canonical: true, origin: 'genesis', activationRehearsal: true },
      { canonical: true, origin: 'demo-fixture', activationRehearsal: false },
      { canonical: true, origin: 'demo-fixture', activationRehearsal: true },
      { canonical: false, origin: 'genesis', activationRehearsal: false },
      { canonical: false, origin: 'genesis', activationRehearsal: true },
      { canonical: false, origin: 'staging', activationRehearsal: false },
      { canonical: false, origin: 'demo-fixture', activationRehearsal: undefined },
      { canonical: false, origin: 'demo-fixture', activationRehearsal: null },
      { canonical: 'false', origin: 'demo-fixture', activationRehearsal: false },
      { canonical: 1, origin: 'genesis', activationRehearsal: 0 },
      { canonical: undefined, origin: undefined, activationRehearsal: undefined },
    ]
    for (const flags of unknown) {
      expect(cityMode(flags), JSON.stringify(flags)).toBeNull()
      // An unknown mode is never treated as a fixture, however sound the state.
      const check = checkAuthoritativeCity({ flags, state: createGenesisState(), properties: [] })
      expect(check.mode).toBeNull()
      expect(check.violations).toEqual([expect.objectContaining({ category: 'mode', rule: 'unknown-mode' })])
    }
  })
})

describe('deep state invariants', () => {
  it('accepts the demo seed, a grown demo city, the empty city and a city with real buildings', () => {
    expect(checkCityState(createSeedState())).toEqual([])
    let grown = createSeedState()
    for (let i = 0; i < 80; i++) grown = joinCity(grown, 'd4').state
    grown = simulateDistrictGrowth(grown, 'd2').state
    grown = joinAtPlot(grown, { districtId: 'd9', ward: 1, plot: 4 }).state
    expect(Object.keys(grown.buildings).length).toBeGreaterThan(260)
    expect(checkCityState(grown)).toEqual([])
    expect(checkCityState(createGenesisState())).toEqual([])
    expect(checkCityState(activatedCity().state)).toEqual([])
  })

  it('goes further than the shape check: a drawable state can still be wrong', async () => {
    const { isCityStateShape } = await import('./stateSchema')
    const { state } = activatedCity()
    state.buildings['b-77'] = { ...state.buildings['b-77'], districtId: 'd4', plot: 3 }
    expect(isCityStateShape(state)).toBe(true)
    expect(rules(checkCityState(state))).toEqual(['plot-unique'])
  })

  it('rejects anything that is not a state at all', () => {
    for (const bad of [null, undefined, 5, 'state', [], [createGenesisState()]]) expect(checkCityState(bad), String(bad)).toEqual([expect.objectContaining({ category: 'state', rule: 'state-object' })])
    expect(rules(checkCityState({}))).toEqual(['collection', 'counter', 'version'])
    expect(rules(checkCityState({ ...createGenesisState(), version: 4 }))).toEqual(['version'])
    expect(rules(checkCityState({ ...createGenesisState(), buildings: [] }))).toEqual(['collection'])
    expect(rules(checkCityState({ ...createGenesisState(), users: null }))).toEqual(['collection'])
    expect(rules(checkCityState({ ...createGenesisState(), radio: {} }))).toEqual(['collection'])
    expect(rules(checkCityState({ ...createGenesisState(), clock: -1 }))).toEqual(['counter'])
    expect(rules(checkCityState({ ...createGenesisState(), residentSeq: 1.5 }))).toEqual(['counter'])
  })

  it('rejects a duplicate Friend', () => {
    const v = after((s) => {
      s.buildings['b-900'] = { ...s.buildings['b-812'], id: 'b-900', plot: 20 }
    })
    expect(rules(v)).toEqual(['building-id', 'friend-unique'])
    expect(categories(v)).toEqual(['buildings'])
  })

  it('rejects a duplicate plot', () => {
    const v = after((s) => {
      s.buildings['b-900'] = { ...s.buildings['b-812'], id: 'b-900', friendId: 900 }
    })
    expect(rules(v)).toEqual(['plot-unique'])
    expect(v[0].detail).toContain('d4-w0-p3')
  })

  it('rejects a building filed under a key that is not its id', () => {
    expect(rules(after((s) => { s.buildings['b-999'] = s.buildings['b-812']; delete s.buildings['b-812'] }))).toEqual(['building-key'])
  })

  it('rejects a building whose id is not b-<its Friend>', () => {
    expect(rules(after((s) => { s.buildings['b-812'].friendId = 813 }))).toEqual(['building-id'])
    expect(rules(after((s) => { s.buildings['x-812'] = { ...s.buildings['b-812'], id: 'x-812' }; delete s.buildings['b-812'] }))).toEqual(['building-id'])
  })

  it('rejects a Friend id that is not a non-negative safe integer', () => {
    for (const friendId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '812', null])
      expect(rules(after((s) => { ;(s.buildings['b-812'] as { friendId: unknown }).friendId = friendId })), String(friendId)).toEqual(['friend-id'])
  })

  it('rejects an invalid district', () => {
    for (const districtId of ['d0', 'd10', 'D4', '', 4, null]) expect(rules(after((s) => { ;(s.buildings['b-812'] as { districtId: unknown }).districtId = districtId })), String(districtId)).toEqual(['district'])
    expect(rules(checkCityState({ ...createGenesisState(), wards: { ...createGenesisState().wards, d10: 1 } }))).toEqual(['district'])
  })

  it('rejects an invalid ward and an invalid plot', () => {
    for (const ward of [-1, 0.5, '0', null]) expect(rules(after((s) => { ;(s.buildings['b-812'] as { ward: unknown }).ward = ward })), String(ward)).toEqual(['ward'])
    for (const plot of [-1, 2.5, '3', undefined]) expect(rules(after((s) => { ;(s.buildings['b-812'] as { plot: unknown }).plot = plot })), String(plot)).toEqual(['plot'])
  })

  it('rejects a building in a ward that is not open', () => {
    expect(rules(after((s) => { s.buildings['b-812'].ward = 1 }))).toEqual(['ward-open'])
    // Opening the ward makes the same building valid.
    expect(after((s) => { s.buildings['b-812'].ward = 1; s.wards.d4 = 2 })).toEqual([])
  })

  it('rejects a plot beyond its ward\'s capacity', () => {
    const capacity = wardCapacity(0)
    expect(after((s) => { s.buildings['b-812'].plot = capacity - 1 })).toEqual([])
    expect(rules(after((s) => { s.buildings['b-812'].plot = capacity }))).toEqual(['plot-capacity'])
  })

  it('rejects a building whose owner is not a user of the city', () => {
    expect(rules(after((s) => { s.buildings['b-812'].ownerId = 'ghost' }))).toEqual(['owner-user'])
    expect(rules(after((s) => { delete s.users['user-812'] }))).toEqual(['owner-user'])
    expect(rules(after((s) => { ;(s.buildings['b-812'] as { ownerId: unknown }).ownerId = undefined }))).toEqual(['owner-user'])
  })

  it('rejects wards that are not a positive whole number for every district', () => {
    for (const wards of [0, -1, 1.5, '1', null]) expect(rules(after((s) => { ;(s.wards as Record<string, unknown>).d4 = wards })), String(wards)).toContain('wards')
    expect(rules(after((s) => { delete (s.wards as Partial<GameState['wards']>).d7 }))).toEqual(['wards'])
  })

  it('rejects users that are not what they are filed as', () => {
    expect(rules(after((s) => { s.users['user-812'].id = 'someone-else' }))).toEqual(['user-key'])
    expect(rules(after((s) => { s.users['user-812'].handle = '' }))).toEqual(['user-shape'])
    expect(rules(after((s) => { s.users['user-812'].friendId = -5 }))).toEqual(['user-avatar'])
    expect(rules(after((s) => { s.wallets.ghost = 10 }))).toEqual(['wallet-user'])
    expect(rules(after((s) => { s.wallets['user-812'] = -1 }))).toEqual(['wallet-balance'])
  })

  it('never reads a user\'s display Friend as authority over anything', () => {
    // Whatever avatar any user shows, the verdict on the city is the same: the validator does not look at it.
    const verdict = (avatars: Record<string, number>) => {
      const { state, properties } = activatedCity()
      state.users.visitor = { id: 'visitor', handle: 'visitor', friendId: 1, hue: 0 }
      for (const [user, friendId] of Object.entries(avatars)) state.users[user].friendId = friendId
      // One user holds two properties; the third is someone else's.
      state.buildings['b-4471'].ownerId = 'user-812'
      return { owners: Object.values(state.buildings).map((b) => `${b.id}:${b.ownerId}`), violations: checkAuthoritativeCity({ flags: REHEARSAL, state, properties }).violations }
    }
    const honest = verdict({})
    expect(honest).toEqual({ owners: ['b-812:user-812', 'b-77:user-77', 'b-4471:user-812'], violations: [] })
    // Showing someone else's Friend, a Friend that has no property, or the same Friend as another user changes nothing.
    const shown: Record<string, number>[] = [{ 'user-77': 812 }, { visitor: 812 }, { visitor: 999_999 }, { 'user-812': 77, 'user-77': 77, visitor: 77 }, { 'user-812': 0 }]
    for (const avatars of shown) expect(verdict(avatars), JSON.stringify(avatars)).toEqual(honest)
  })

  it('rejects things that are held by nothing real', () => {
    expect(rules(after((s) => { s.crown = { holder: 'b-1', sinceClock: 0 } }))).toEqual(['holding'])
    expect(rules(after((s) => { ;(s.capital as { holder: unknown }).holder = 'd12' }))).toEqual(['holding'])
    expect(rules(after((s) => { ;(s.monuments.m4 as { holder: unknown }).holder = 'b-812' }))).toEqual(['holding'])
    expect(after((s) => { s.crown = { holder: 'b-812', sinceClock: 1 }; s.capital = { holder: 'd4', sinceClock: 1 } })).toEqual([])
    expect(rules(after((s) => { s.season.representatives['user-812'] = { buildingId: 'b-404', districtId: 'd4', chosenClock: 0 } }))).toEqual(['season'])
  })

  it('rejects a user filed under a key that is not a plain id', () => {
    for (const key of ['__proto__', 'constructor ', '', ' ', 'a b', '<script>', 'x'.repeat(200)]) {
      const state = JSON.parse(JSON.stringify(createGenesisState())) as GameState
      Object.defineProperty(state.users, key, { value: { id: key, handle: 'h', friendId: 1, hue: 0 }, enumerable: true, configurable: true, writable: true })
      expect(rules(checkCityState(state)), JSON.stringify(key)).toEqual(['user-id'])
    }
    // The ids the demo and a real city use are all plain.
    for (const key of ['demo-player', 'npc-01', 'resident-12', 'sim-resident-3', '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11']) {
      const state = createGenesisState()
      state.users[key] = { id: key, handle: 'h', friendId: 1, hue: 0 }
      expect(checkCityState(state), key).toEqual([])
    }
  })

  it('does not follow a name into the language: __proto__ is never a building, a user or a monument', () => {
    const parsed = (json: string) => JSON.parse(json) as GameState
    const base = JSON.stringify(activatedCity().state)
    const withRep = parsed(base)
    ;(withRep.season.representatives as Record<string, unknown>)['user-812'] = JSON.parse('{"buildingId":"__proto__","chosenClock":0}')
    expect(rules(checkCityState(withRep))).toEqual(['season'])
    const withCrown = parsed(base)
    ;(withCrown.crown as { holder: unknown }).holder = '__proto__'
    expect(rules(checkCityState(withCrown))).toEqual(['holding'])
    const withOwner = parsed(base)
    withOwner.buildings['b-812'].ownerId = 'hasOwnProperty'
    expect(rules(checkCityState(withOwner))).toEqual(['owner-user'])
    const withBuilding = parsed(base.replace('"b-812":', '"__proto__":'))
    expect(rules(checkCityState(withBuilding))).toContain('building-key')
  })

  it('rejects a Representative that is not a building its user owns', () => {
    expect(after((s) => { s.season.representatives['user-812'] = { buildingId: 'b-812', districtId: 'd4', chosenClock: 0 } })).toEqual([])
    expect(rules(after((s) => { s.season.representatives['user-812'] = { buildingId: 'b-77', districtId: 'd9', chosenClock: 0 } }))).toEqual(['season'])
    expect(rules(after((s) => { s.season.representatives['user-812'] = { buildingId: 'b-812', districtId: 'd5', chosenClock: 0 } }))).toEqual(['season'])
    expect(rules(after((s) => { s.season.representatives.ghost = { buildingId: 'b-812', districtId: 'd4', chosenClock: 0 } }))).toEqual(['season'])
  })

  it('rejects contributions by, and parts made of, things that are not what they should be', () => {
    expect(rules(after((s) => { s.buildings['b-812'].patrons.ghost = 5 }))).toEqual(['patron-user'])
    expect(after((s) => { s.buildings['b-812'].patrons['user-77'] = 5 })).toEqual([])
    const part = (change: (b: Record<string, unknown>) => void) => rules(after((s) => change(s.buildings['b-812'] as unknown as Record<string, unknown>)))
    expect(part((b) => { b.fixtures = [null, 5, {}] })).toEqual(['building-shape'])
    expect(part((b) => { b.landscapeSlots = [7] })).toEqual(['building-shape'])
    expect(part((b) => { b.milestones = ['x'] })).toEqual(['building-shape'])
    expect(part((b) => { b.billboard = { image: 5 } })).toEqual(['building-shape'])
    expect(part((b) => { b.architecture = { facade: 3 } })).toEqual(['building-shape'])
    expect(part((b) => { b.landscapeInventory = { tree: -1 } })).toEqual(['building-shape'])
    expect(rules(after((s) => { ;(s.radio as unknown[]).push(null, 7) }))).toEqual(['radio'])
    expect(rules(after((s) => { ;(s.alertKeys as unknown[]).push(5) }))).toEqual(['radio'])
    expect(rules(after((s) => { ;(s.capital as { sinceClock: unknown }).sinceClock = 'never' }))).toEqual(['holding'])
    expect(rules(after((s) => { ;(s.monuments as Record<string, unknown>).m9 = { holder: null, sinceClock: 0 } }))).toEqual(['holding'])
  })

  it('rejects wards standing open beyond the last occupied one', () => {
    expect(rules(after((s) => { s.wards.d4 = 2 }))).toEqual(['wards'])
    expect(rules(after((s) => { s.wards.d1 = Number.MAX_SAFE_INTEGER }))).toEqual(['wards'])
    expect(after((s) => { s.wards.d4 = 2; s.buildings['b-812'].ward = 1 })).toEqual([])
    expect(rules(after((s) => { s.wards.d4 = 3; s.buildings['b-812'].ward = 1 }))).toEqual(['wards'])
  })

  it('caps its report', () => {
    const state = createGenesisState()
    for (let i = 0; i < 500; i++) (state.buildings as Record<string, unknown>)[`b-${i}`] = { id: `wrong-${i}` }
    expect(checkCityState(state)).toHaveLength(100)
  })
})

describe('property parity', () => {
  it('accepts an empty canonical city and an empty rehearsal city with zero properties', () => {
    expect(checkAuthoritativeCity({ flags: CANONICAL, state: createGenesisState(), properties: [] })).toEqual({ mode: 'canonical', violations: [] })
    expect(checkAuthoritativeCity({ flags: REHEARSAL, state: createGenesisState(), properties: [] })).toEqual({ mode: 'rehearsal', violations: [] })
  })

  it('accepts a city whose buildings are exactly its properties', () => {
    const { state, properties } = activatedCity()
    expect(checkAuthoritativeCity({ flags: REHEARSAL, state, properties })).toEqual({ mode: 'rehearsal', violations: [] })
    expect(checkAuthoritativeCity({ flags: CANONICAL, state, properties: [...properties].reverse() })).toEqual({ mode: 'canonical', violations: [] })
  })

  it('validates the ordinary demo fixture as a demo fixture, without pretending its buildings are properties', () => {
    const seed = createSeedState()
    expect(checkAuthoritativeCity({ flags: FIXTURE, state: seed, properties: [] })).toEqual({ mode: 'demo-fixture', violations: [] })
    // The same 180 buildings in a city that may hold real properties are 180 buildings with no property.
    const asRehearsal = checkAuthoritativeCity({ flags: REHEARSAL, state: seed, properties: [] })
    expect(asRehearsal.mode).toBe('rehearsal')
    expect(rules(asRehearsal.violations)).toEqual(['building-without-property', 'count', 'simulated-wallet'])
    // A fixture is still held to its own internal rules...
    const broken = createSeedState()
    broken.buildings['b-812'].ownerId = 'ghost'
    expect(rules(checkAuthoritativeCity({ flags: FIXTURE, state: broken, properties: [] }).violations)).toEqual(['owner-user'])
    // ...and may never have property rows.
    expect(rules(checkAuthoritativeCity({ flags: FIXTURE, state: seed, properties: [activatedCity().properties[0]] }).violations)).toEqual(['fixture-has-properties'])
  })

  it('rejects simulated RF in a city that may hold real properties, and only there', () => {
    const { state, properties } = activatedCity()
    state.wallets['user-812'] = 500
    expect(checkCityState(state)).toEqual([])
    for (const flags of [REHEARSAL, CANONICAL]) expect(rules(checkAuthoritativeCity({ flags, state, properties }).violations)).toEqual(['simulated-wallet'])
    expect(Object.keys(createSeedState().wallets)).toEqual(['demo-player'])
    expect(checkAuthoritativeCity({ flags: FIXTURE, state: createSeedState(), properties: [] }).violations).toEqual([])
  })

  it('rejects a property without a building', () => {
    const { state, properties } = activatedCity()
    delete state.buildings['b-812']
    const v = checkAuthoritativeCity({ flags: REHEARSAL, state, properties }).violations
    expect(rules(v)).toEqual(['count', 'property-without-building'])
    expect(categories(v)).toEqual(['properties'])
  })

  it('rejects a building without a property in an activatable city', () => {
    for (const flags of [REHEARSAL, CANONICAL]) {
      const { state, properties } = activatedCity()
      expect(rules(checkAuthoritativeCity({ flags, state, properties: properties.slice(1) }).violations)).toEqual(['building-without-property', 'count'])
    }
  })

  it('rejects a property and building that disagree about the token', () => {
    const { state, properties } = activatedCity()
    const wrong = properties.map((p) => (p.tokenId === '812' ? { ...p, tokenId: '813' } : p))
    expect(rules(checkPropertyParity(state, wrong))).toEqual(['building-id', 'token-mismatch'])
  })

  it('rejects a property and building that disagree about the plot, ward or district', () => {
    const { state, properties } = activatedCity()
    const at = (patch: Partial<PropertyFacts>) => properties.map((p) => (p.tokenId === '812' ? { ...p, ...patch } : p))
    expect(rules(checkPropertyParity(state, at({ plot: 4, plotId: 'd4-w0-p4' })))).toEqual(['plot-mismatch'])
    expect(rules(checkPropertyParity(state, at({ ward: 1, plotId: 'd4-w1-p3' })))).toEqual(['plot-mismatch'])
    expect(rules(checkPropertyParity(state, at({ plotId: 'd4-w0-p9' })))).toEqual(['plot-id'])
    state.buildings['b-812'].districtId = 'd5'
    expect(rules(checkPropertyParity(state, properties))).toEqual(['district-mismatch'])
  })

  it('rejects a family in the wrong district', () => {
    const { state, properties } = activatedCity()
    const moved = properties.map((p) => (p.tokenId === '812' ? { ...p, familyId: 3 } : p))
    const v = checkPropertyParity(state, moved)
    expect(rules(v)).toEqual(['family-district'])
    expect(v[0].detail).toContain('that family lives in d5')
    expect(rules(checkPropertyParity(state, properties.map((p) => (p.tokenId === '812' ? { ...p, familyId: 9 } : p))))).toEqual(['family-district'])
  })

  it('rejects two properties sharing a building, and a token id the state cannot hold', () => {
    const { state, properties } = activatedCity()
    expect(rules(checkPropertyParity(state, [...properties, { ...properties[0], propertyId: 'p-dup' }]))).toEqual(['building-shared', 'count'])
    const huge = properties.map((p) => (p.tokenId === '812' ? { ...p, tokenId: '9007199254740993', buildingId: 'b-9007199254740993' } : p))
    expect(rules(checkPropertyParity(state, huge))).toEqual(expect.arrayContaining(['token', 'property-without-building']))
  })

  it('does not attempt parity over a state it could not read', () => {
    const check = checkAuthoritativeCity({ flags: REHEARSAL, state: { version: 5 }, properties: activatedCity().properties })
    expect(check.mode).toBe('rehearsal')
    expect(categories(check.violations)).toEqual(['state'])
  })
})
