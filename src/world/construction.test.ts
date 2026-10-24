import { describe, expect, it } from 'vitest'
import { compileBrandWorld } from '../brand/core/layout'
import { persistedBrandCityState, renderedBuilt } from '../brand/core/persisted'
import { parsePlayCityConfig } from '../brand/core/playConfig'
import { loadPersistedBrandCity } from '../brand/load'
import { TIER_THRESHOLDS } from '../config/economy'
import { stageFor, tierFor, totalBuilt } from '../game/economy'
import { parseRehearsalConstructionResponse, parseRehearsalConstructionView, type RehearsalConstructionView } from '../protocol/playRehearsal'
import { nftAsset, type NftAsset } from './asset'
import { emptyWorldCityState, parseWorldCityState, worldCityStateText, type WorldCityState } from './cityState'
import { constructionStep, constructionTier, developmentProblems, LOCAL_TEST_CONSTRUCTION_RECIPE, nextTierAt, proposePropertyConstruction, type ConstructionRecipe } from './construction'
import { proposePropertyActivation, replayWorldCity, worldCityProblems, type RecordedCityChange } from './gameplay'
import { worldProperty } from './property'

const WORLD = '01890a5d-ac96-774b-bcce-b302099a8057'
const contract = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`
const DOC = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight', logo: null },
  capital: { name: 'Beacon Hall', crest: null },
  collections: [{ key: 'harbor-keepers', chain: 'eip155:8453', contract: contract(0xa001), displayName: 'Harbor Keepers' }],
  districts: ['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row'].map((key) => ({ key, name: key, accent: '#5aa9ff', monument: null, proofyRule: null })),
}
const parsed = parsePlayCityConfig(DOC, WORLD)
if (!parsed.ok) throw new Error('config')
const compiled = compileBrandWorld(parsed.config)
if (!compiled.ok) throw new Error('world')
const world = compiled.world
const keeper = (id: number): NftAsset => nftAsset({ chain: 'eip155:8453', contract: contract(0xa001), tokenId: String(id) })!
const building = (id: number) => worldProperty(world, keeper(id))!.buildingId
const R = LOCAL_TEST_CONSTRUCTION_RECIPE

/** Two properties placed at sequences 2 and 3. */
function placed() {
  const a = proposePropertyActivation(world, emptyWorldCityState(), 1, { asset: keeper(1), plotId: 'tidewater-w0-p0' })
  if (!a.ok) throw new Error(a.reason)
  const b = proposePropertyActivation(world, a.transition.state, 2, { asset: keeper(2), plotId: 'lantern-quay-w0-p3' })
  if (!b.ok) throw new Error(b.reason)
  return b.transition.state
}

function build(state: WorldCityState, sequence: number, id: number, recipe: ConstructionRecipe = R) {
  const p = proposePropertyConstruction(state, sequence, { buildingId: building(id), recipe })
  if (!p.ok) throw new Error(p.reason)
  return p.transition
}

describe('construction, pure: the local test recipe', () => {
  it('is provisional local tuning: one step of 50 units, Tier 1 at 100, nothing above', () => {
    expect(R).toEqual({ key: 'local-test-tier1-v1', unitsPerAction: 50, tierThresholds: [100] })
    expect(Object.isFrozen(R) && Object.isFrozen(R.tierThresholds)).toBe(true)
    expect([0, 49, 50, 99, 100, 150].map((b) => constructionTier(R, b))).toEqual([0, 0, 0, 0, 1, 1])
    expect([0, 50, 80, 100].map((b) => constructionStep(R, b))).toEqual([50, 50, 20, null])
    expect([0, 50, 100].map((b) => nextTierAt(R, b))).toEqual([100, 100, null])
  })
})

describe('construction, pure: proposal', () => {
  it('builds Tier 0 to Tier 1 in two steps, one sequence each; the state becomes version 3 and keeps every property where it was', () => {
    const v2 = placed()
    const first = build(v2, 3, 1)
    expect(first).toMatchObject({ from: 3, to: 4, units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0, recipe: 'local-test-tier1-v1' })
    expect(first.state).toEqual({ version: 3, buildings: v2.buildings, openWards: v2.openWards, development: { [building(1)]: { tier: 0, built: 50, sequence: 4 } } })
    expect(first.event).toEqual({ propertyId: worldProperty(world, keeper(1))!.propertyId, buildingId: building(1), recipe: R.key, units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0 })
    const second = build(first.state, 4, 1)
    expect(second).toMatchObject({ to: 5, builtAfter: 100, tierBefore: 0, tierAfter: 1 })
    expect(proposePropertyConstruction(second.state, 5, { buildingId: building(1), recipe: R })).toEqual({ ok: false, reason: 'construction-complete' })
    // The input is never changed.
    expect(v2.version).toBe(2)
  })

  it('names only a building: never an amount or tier; an unknown building or an empty city is refused', () => {
    expect(proposePropertyConstruction(placed(), 3, { buildingId: 'b-00000000-0000-8000-8000-000000000000', recipe: R })).toEqual({ ok: false, reason: 'unknown-property' })
    expect(() => proposePropertyConstruction(emptyWorldCityState(), 1, { buildingId: building(1), recipe: R })).toThrow(/Invalid city sequence/)
    expect(proposePropertyConstruction(emptyWorldCityState(), 2, { buildingId: building(1), recipe: R })).toEqual({ ok: false, reason: 'unknown-property' })
  })

  it('keeps development in building order, whichever is built first; an activation afterwards keeps version 3 and adds no development', () => {
    const v2 = placed()
    const second = build(v2, 3, 2)
    const both = build(second.state, 4, 1)
    expect(Object.keys((both.state as Extract<WorldCityState, { version: 3 }>).development)).toEqual([building(1), building(2)])
    const later = proposePropertyActivation(world, both.state, 5, { asset: keeper(3), plotId: 'saltmarsh-w0-p0' })
    if (!later.ok) throw new Error(later.reason)
    expect(later.transition.state.version).toBe(3)
    expect(later.transition.state).toMatchObject({ development: { [building(1)]: { built: 50 }, [building(2)]: { built: 50 } } })
    expect(Object.keys((later.transition.state as Extract<WorldCityState, { version: 3 }>).development)).toEqual([building(1), building(2)])
    expect(later.transition.building.sequence).toBe(6)
    expect(worldCityProblems(world, later.transition.state)).toEqual([])
  })
})

describe('construction, pure: stored state and replay', () => {
  it('reads version 3 exactly, and refuses any other spelling of it', () => {
    const t = build(placed(), 3, 1)
    const text = worldCityStateText(t.state)
    expect(parseWorldCityState(JSON.parse(text))).toEqual(t.state)
    const bad = (patch: (s: Record<string, unknown>) => void) => {
      const s = JSON.parse(text)
      patch(s)
      return parseWorldCityState(s)
    }
    expect(bad((s) => (s.development = {}))).toBeNull()
    expect(bad((s) => delete s.development)).toBeNull()
    expect(bad((s) => (s.extra = 1))).toBeNull()
    expect(bad((s) => ((s.development as Record<string, unknown>)['b-00000000-0000-8000-8000-000000000000'] = { tier: 0, built: 1, sequence: 9 }))).toBeNull()
    expect(bad((s) => ((s.development as Record<string, { built: number }>)[building(1)].built = 0))).toBeNull()
    expect(bad((s) => ((s.development as Record<string, { sequence: number }>)[building(1)].sequence = 2))).toBeNull()
    expect(bad((s) => ((s.development as Record<string, Record<string, unknown>>)[building(1)].owner = 'x'))).toBeNull()
    // Version 2 never carries development.
    expect(bad((s) => (s.version = 2))).toBeNull()
  })

  it('finds an impossible development: a tier its units do not make, more than the recipe builds, a sequence another change holds', () => {
    const t = build(placed(), 3, 1)
    const with_ = (d: Record<string, unknown>) => ({ ...t.state, development: { [building(1)]: { ...t.state.development[building(1)], ...d } } }) as WorldCityState
    expect(developmentProblems(t.state)).toEqual([])
    expect(developmentProblems(with_({ tier: 1 }))[0]).toMatch(/records tier 1; 50 units make it tier 0/)
    expect(developmentProblems(with_({ built: 150, tier: 1 }))[0]).toMatch(/builds at most 100/)
    expect(developmentProblems(with_({ sequence: 3 }))[0]).toMatch(/another change of the city holds/)
    expect(worldCityProblems(world, with_({ tier: 1 })).length).toBeGreaterThan(0)
  })

  it('a replay of activations and constructions together rebuilds the state byte for byte, and refuses a gap or an impossible step', () => {
    const v2 = placed()
    const one = build(v2, 3, 1)
    const two = build(one.state, 4, 2)
    const three = build(two.state, 5, 1)
    const steps: RecordedCityChange[] = [
      { kind: 'activation', world, request: { asset: keeper(1), plotId: 'tidewater-w0-p0' }, sequence: 2 },
      { kind: 'activation', world, request: { asset: keeper(2), plotId: 'lantern-quay-w0-p3' }, sequence: 3 },
      { kind: 'construction', buildingId: building(1), recipe: R, sequence: 4 },
      { kind: 'construction', buildingId: building(2), recipe: R, sequence: 5 },
      { kind: 'construction', buildingId: building(1), recipe: R, sequence: 6 },
    ]
    const replay = replayWorldCity(steps)
    if (!replay.ok) throw new Error(replay.detail)
    expect(worldCityStateText(replay.state)).toBe(worldCityStateText(three.state))
    expect(replay.changes.map((c) => c.kind)).toEqual(['activation', 'activation', 'construction', 'construction', 'construction'])
    expect(replayWorldCity(steps.filter((_, i) => i !== 2))).toMatchObject({ ok: false, index: 2 })
    expect(replayWorldCity([...steps, { kind: 'construction', buildingId: building(1), recipe: R, sequence: 7 }])).toMatchObject({ ok: false, detail: expect.stringMatching(/construction-complete/) })
  })
})

describe('construction, drawn: the standard renderer shows the stored tier and nothing the server did not store', () => {
  it('maps progress inside Tier 0 short of Tier 1, and Tier 1 exactly onto the renderer\'s Tier 1', () => {
    expect(renderedBuilt(null)).toBe(0)
    expect(renderedBuilt({ tier: 0, built: 50, sequence: 4 })).toBe(Math.floor(TIER_THRESHOLDS[0] / 2))
    expect(tierFor(renderedBuilt({ tier: 0, built: 99, sequence: 4 }))).toBe(0)
    expect(renderedBuilt({ tier: 1, built: 100, sequence: 5 })).toBe(TIER_THRESHOLDS[0])
    expect(tierFor(renderedBuilt({ tier: 1, built: 100, sequence: 5 }))).toBe(1)
    expect(stageFor(renderedBuilt({ tier: 1, built: 100, sequence: 5 }))).toBe(1)
  })

  it('a stored Tier 1 property is drawn at Tier 1 through the persisted loader, on its exact plot, with no owner', () => {
    const v2 = placed()
    const t = build(build(v2, 3, 1).state, 4, 1)
    const loaded = loadPersistedBrandCity(parsed.config, t.state, world.layout.geometryFingerprint)
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems))
    const b = loaded.city.state.buildings[building(1)]
    expect(tierFor(totalBuilt(b))).toBe(1)
    expect(b).toMatchObject({ districtId: 'tidewater', ward: 0, plot: 0, ownerId: '', patrons: {} })
    expect(tierFor(totalBuilt(loaded.city.state.buildings[building(2)]))).toBe(0)
    // A version 2 city draws exactly as before: nothing built anywhere.
    const before = persistedBrandCityState(parsed.config, v2)
    expect(Object.values(before.buildings).map((x) => x.ownerBuilt)).toEqual([0, 0])
  })

  it('local test construction earns no Crown, Capital or monument (independent audit M2): a test-built building is drawn at its tier and holds nothing', () => {
    // One step (the Crown went to it before), then Tier 1 (its district was the Capital before).
    for (const t of [build(placed(), 3, 1), build(build(placed(), 3, 1).state, 4, 1)]) {
      const drawn = persistedBrandCityState(parsed.config, t.state)
      expect(totalBuilt(drawn.buildings[building(1)])).toBeGreaterThan(0)
      expect(drawn.crown).toEqual({ holder: null, sinceClock: 0 })
      expect(drawn.capital).toEqual({ holder: null, sinceClock: 0 })
      expect(Object.values(drawn.monuments).every((m) => m.holder === null)).toBe(true)
    }
    expect(tierFor(totalBuilt(persistedBrandCityState(parsed.config, build(build(placed(), 3, 1).state, 4, 1).state).buildings[building(1)]))).toBe(1)
  })
})

describe('construction, wire: the page reads exactly what the server answers', () => {
  const view: RehearsalConstructionView = {
    rehearsal: { kind: 'local-test-assets', verified: false },
    resource: 'local-test-credit',
    recipe: { key: 'local-test-tier1-v1', unitsPerAction: 50, tierThresholds: [100], provisional: true },
    property: { propertyId: '0190aaaa-0000-8000-8000-000000000001', buildingId: 'b-0190aaaa-0000-8000-8000-000000000001', tier: 0, built: 50, nextTierAt: 100, maxTier: 1 },
    control: 'viewer',
    standing: { kind: 'ready', role: 'owner', units: 50 },
    credits: { available: 70, recorded: 70, pending: 0 },
    investment: { currentOwner: 50, previousOwners: 0, community: 0, total: 50 },
    viewer: { ownerUnits: 50, patronUnits: 0 },
    history: [{ sequence: 4, role: 'owner', units: 50, tierAfter: 0, by: 'viewer', era: 1, at: '2026-10-22T12:00:00.000Z' }],
    historyCount: 1,
  }
  it('parses a view exactly and refuses one that does not add up, is not marked as local test data, or says more', () => {
    expect(parseRehearsalConstructionView(structuredClone(view))).toEqual(view)
    const bad = (patch: (v: Record<string, unknown>) => void) => {
      const v = structuredClone(view) as unknown as Record<string, unknown>
      patch(v)
      return parseRehearsalConstructionView(v)
    }
    expect(bad((v) => (v.resource = 'rf'))).toBeNull()
    expect(bad((v) => ((v.rehearsal as Record<string, unknown>).verified = true))).toBeNull()
    expect(bad((v) => ((v.recipe as Record<string, unknown>).provisional = false))).toBeNull()
    expect(bad((v) => ((v.credits as Record<string, number>).available = 1000))).toBeNull()
    expect(bad((v) => ((v.investment as Record<string, number>).community = 10))).toBeNull()
    expect(bad((v) => (v.control = 'verified'))).toBeNull()
    expect(bad((v) => (v.owner = 'x'))).toBeNull()
    expect(bad((v) => (((v.history as Record<string, unknown>[])[0]).by = '111111111111111111'))).toBeNull()
  })
  it('parses an answer whose construction belongs to its view', () => {
    const answer = { rehearsal: view.rehearsal, resource: 'local-test-credit', fresh: true, sequence: 4, balance: 70, construction: { sequence: 4, propertyId: view.property.propertyId, actionId: '0190aaaa-0000-4000-8000-0000000000aa', role: 'owner', era: 1, units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0, constructedAt: '2026-10-22T12:00:00.000Z' }, view }
    expect(parseRehearsalConstructionResponse(structuredClone(answer))).toEqual(answer)
    expect(parseRehearsalConstructionResponse({ ...structuredClone(answer), construction: { ...answer.construction, builtAfter: 60 } })).toBeNull()
    expect(parseRehearsalConstructionResponse({ ...structuredClone(answer), construction: { ...answer.construction, propertyId: '0190aaaa-0000-8000-8000-000000000002' } })).toBeNull()
  })
  it('parses a construction answered without its view (built, but not read again), and nothing else in its place', () => {
    const answer = { rehearsal: view.rehearsal, resource: 'local-test-credit', fresh: true, sequence: 4, balance: 70, construction: { sequence: 4, propertyId: view.property.propertyId, actionId: '0190aaaa-0000-4000-8000-0000000000aa', role: 'owner', era: 1, units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0, constructedAt: '2026-10-22T12:00:00.000Z' }, view: null }
    expect(parseRehearsalConstructionResponse(structuredClone(answer))).toEqual(answer)
    expect(parseRehearsalConstructionResponse(Object.fromEntries(Object.entries(answer).filter(([k]) => k !== 'view')))).toBeNull()
    expect(parseRehearsalConstructionResponse({ ...structuredClone(answer), view: {} })).toBeNull()
    expect(parseRehearsalConstructionResponse({ ...structuredClone(answer), construction: { ...answer.construction, propertyId: 'b-1' } })).toBeNull()
  })
})
