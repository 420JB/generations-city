import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RehearsalConstructionView, RehearsalDesignView } from '../../protocol/playRehearsal'
import { CitySceneContext } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, worldBuildingId, type WorldCityState } from '../../world/cityState'
import { ARCHITECT_DESIGN_V4 } from '../../world/design'
import { proposePropertyActivation } from '../../world/gameplay'
import { parseBrandCityConfig } from '../core/config'
import { compileBrandWorld } from '../core/layout'
import { loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import type { ConstructionAccess } from './construction'
import { constructionActionOf, type ConstructionState } from './constructionState'
import type { DesignAccess, DesignLoad } from './design'
import { designEditable } from './designAnswer'
import { PropertyContextCard } from './home'
import { BuildingPreviewPanel } from './panels'
import { propertyContext } from './properties'
import { buildReason, CONTROL_LINES, controlStatusOf, designReason } from './propertyStatus'
import type { StoredProperty } from './rehearsal'

/**
 * A STORED property's panel leads with what the player can do (P1-E6): its header (address, tier, who the local file names
 * as its controller), then its two actions (build or contribute; customize), its construction and its Architect design,
 * and only then its records (district, founder, identifiers, founding record, construction records, legacy). Every action
 * is offered only as the server's answers allow, and each one not offered says why.
 */

const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'
const parsed = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
if (!parsed.ok) throw new Error('sample invalid')
const config = parsed.config
const compiled = compileBrandWorld(config)
if (!compiled.ok) throw new Error('world')
const [keepers] = config.collections
let state: WorldCityState = emptyWorldCityState()
for (const [i, plotId] of ['lantern-quay-w0-p0', 'lantern-quay-w0-p1'].entries()) {
  const next = proposePropertyActivation(compiled.world, state, i + 1, { asset: nftAsset({ chain: keepers.chain, contract: keepers.contract, tokenId: String(800 + i) })!, plotId })
  if (!next.ok) throw new Error(next.reason)
  state = next.transition.state
}
const [first] = Object.values(state.buildings).map((b) => b.propertyId)
const loaded = loadPersistedBrandCity(config, state, compiled.world.layout.geometryFingerprint)
if (!loaded.ok) throw new Error('load')
const CITY: LoadedBrandCity = loaded.city
const html = (el: ReactElement) => renderToStaticMarkup(createElement(CitySceneContext.Provider, { value: CITY.scene }, el))
const text = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const OWNERSHIP = /\b(own|owns|owned|owner|owners|ownership|yours)\b/i
const stored: StoredProperty = { ...state.buildings[worldBuildingId(first)], activator: 'viewer', order: 1 }

/** Access whose answers never arrive (a server-rendered panel runs no effect): the panel as it first draws. */
const never = new Promise<never>(() => {})
const pressBook = { unresolved: () => null, next: () => ({ actionId: '', worldId: '', discordUserId: '', propertyId: '', role: 'owner' as const, intent: null }), settle: () => {} }
const constructionAccess: ConstructionAccess = { load: () => never, build: () => never, presses: () => pressBook, activity: () => never, legacy: () => never }
const designAccess: DesignAccess = { load: () => never, save: () => never, saves: () => ({ unresolved: () => null, next: () => { throw new Error('no save') }, settle: () => {} }) }
const panel = (extra: object = {}) =>
  html(createElement(BuildingPreviewPanel, { city: CITY, buildingId: worldBuildingId(first), member: null, stored, onDistrict: () => {}, onClose: () => {}, onBuild: () => {}, ...extra }))
const at = (markup: string, testId: string) => {
  const i = markup.indexOf(`data-testid="${testId}"`)
  expect(i, testId).toBeGreaterThan(-1)
  return i
}

describe('a stored property\'s panel leads with what the player can do (P1-E6)', () => {
  it('in a local rehearsal: header, actions, construction and design come first; records, identifiers and legacy after', () => {
    const context = createElement(PropertyContextCard, { city: CITY, context: propertyContext(CITY, worldBuildingId(first))!, onWarp: () => {}, onDistrict: () => {} })
    const m = panel({ construction: constructionAccess, design: designAccess, onDesign: () => {}, onLegacy: () => {}, onArchitect: () => {}, context })
    const order = ['property-head', 'building-address', 'property-control', 'panel-tier', 'property-actions', 'property-action-build', 'property-action-design', 'construction-card', 'design-card', 'property-records', 'property-context', 'property-founder', 'property-holder', 'property-identifiers', 'property-id', 'stored-property', 'stored-property-asset', 'property-legacy-open']
    const positions = order.map((id) => at(m, id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    // Every gameplay control sits ahead of every technical record.
    for (const technical of ['property-identifiers', 'stored-property', 'stored-property-asset', 'property-legacy-open', 'property-context']) {
      for (const action of ['property-action-build', 'property-action-design', 'construction-card', 'design-card']) expect(at(m, action), `${action} before ${technical}`).toBeLessThan(at(m, technical))
    }
    // While the answers are read, nothing is offered as if it were allowed: both actions wait, and say so.
    expect(m).toMatch(/data-testid="property-action-build"[^>]*disabled=""|disabled=""[^>]*data-testid="property-action-build"/)
    expect(m).toMatch(/disabled=""[^>]*data-testid="property-action-design"/)
    expect(m).toMatch(/data-testid="property-control" data-control="checking"/)
    expect(text(m)).toContain('Reading its construction… Reading its design…')
    // The section is a labelled group of real buttons, keyboard reachable.
    expect(m).toContain('role="group" aria-label="What you can do here"')
    expect(m.match(/<button[^>]*data-testid="property-action-(build|design)"/g)).toHaveLength(2)
    expect(text(m)).not.toMatch(OWNERSHIP)
  })

  it('without a local rehearsal: no actions are offered; the construction note and every record stay, in the same order', () => {
    const m = panel({ onBack: () => {} })
    expect(m).not.toContain('property-actions')
    expect(m).not.toContain('construction-card')
    expect(m).not.toContain('design-card')
    expect(m).toMatch(/data-testid="property-control" data-control="unchecked"/)
    expect(text(m)).toContain(CONTROL_LINES.unchecked)
    const positions = ['property-head', 'construction-note', 'property-records', 'property-founder', 'property-identifiers', 'stored-property'].map((id) => at(m, id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(text(m)).not.toMatch(OWNERSHIP)
  })
})

const recipe = { key: 'local-test-tier2-v1', unitsPerAction: 50, tierThresholds: [100, 250], provisional: true as const }
const viewOf = (over: Partial<RehearsalConstructionView> = {}): RehearsalConstructionView => ({
  rehearsal: { kind: 'local-test-assets', verified: false },
  resource: 'local-test-credit',
  recipe,
  property: { propertyId: first, buildingId: worldBuildingId(first), tier: 0, built: 0, nextTierAt: 100, maxTier: 2 },
  control: 'viewer',
  standing: { kind: 'ready', role: 'owner', units: 50 },
  credits: { available: 200, recorded: 200, pending: 0 },
  investment: { currentOwner: 0, previousOwners: 0, community: 0, total: 0 },
  viewer: { ownerUnits: 0, patronUnits: 0 },
  contributors: { owners: 0, patrons: 0 },
  history: [],
  historyCount: 0,
  ...over,
})
const stateOf = (over: Partial<ConstructionState> = {}): ConstructionState => ({ propertyId: first, view: null, problem: null, busy: false, done: null, unresolved: null, build: async () => {}, ...over })
const designView = (over: Partial<RehearsalDesignView> = {}): DesignLoad => ({
  ok: true,
  view: {
    rehearsal: { kind: 'local-test-assets', verified: false },
    catalog: { ...ARCHITECT_DESIGN_V4, facades: [...ARCHITECT_DESIGN_V4.facades], roofs: [...ARCHITECT_DESIGN_V4.roofs], windows: [...ARCHITECT_DESIGN_V4.windows], lighting: [...ARCHITECT_DESIGN_V4.lighting], entrances: [...ARCHITECT_DESIGN_V4.entrances], landscaping: [...ARCHITECT_DESIGN_V4.landscaping], colors: [...ARCHITECT_DESIGN_V4.colors], default: { ...ARCHITECT_DESIGN_V4.default } },
    property: { propertyId: first, buildingId: worldBuildingId(first) },
    saved: null,
    control: 'viewer',
    open: true,
    history: [],
    historyCount: 0,
    ...over,
  },
})

describe('who controls it, and which actions it offers, as the server\'s answers say (P1-E6)', () => {
  it('names the controller only as an answer names it: never invented, never the founder by founding', () => {
    expect(controlStatusOf(undefined, null)).toBe('unchecked')
    expect(controlStatusOf(null, stateOf())).toBe('checking')
    expect(controlStatusOf(null, null)).toBe('checking')
    for (const control of ['viewer', 'other', 'unknown'] as const) {
      expect(controlStatusOf(designView({ control }), stateOf()), control).toBe(control)
      expect(controlStatusOf(undefined, stateOf({ view: viewOf({ control }) })), control).toBe(control)
    }
    // The design answer is the panel's word on control; a city whose file opens nothing is said so.
    expect(controlStatusOf(designView({ control: 'viewer', open: false }), stateOf({ view: viewOf({ control: 'viewer' }) }))).toBe('closed')
    expect(controlStatusOf({ ok: false, problem: { message: 'x', kind: 'refused', code: 'construction_not_open' } }, stateOf({ problem: { message: 'x', kind: 'refused', code: 'construction_not_open' } }))).toBe('closed')
    // A refusal that names nobody is never read as anyone's control.
    expect(controlStatusOf({ ok: false, problem: { message: 'x', kind: 'retry', code: 'world_unavailable' } }, stateOf({ problem: { message: 'x', kind: 'retry', code: 'world_unavailable' } }))).toBe('unchecked')
    for (const line of Object.values(CONTROL_LINES)) expect(line).not.toMatch(OWNERSHIP)
  })

  it('offers the construction action exactly as the card does: the controller builds, a patron contributes, and nothing without credits or past the top tier', () => {
    expect(constructionActionOf(stateOf())).toBeNull()
    expect(constructionActionOf(stateOf({ view: viewOf() }))).toEqual({ role: 'owner', label: 'Test construction · 50 TEST credits', short: 'Build · 50 TEST credits', disabled: false })
    expect(constructionActionOf(stateOf({ view: viewOf({ control: 'other', standing: { kind: 'ready', role: 'patron', units: 50 } }) }))).toMatchObject({ role: 'patron', short: 'Contribute · 50 TEST credits', disabled: false })
    expect(constructionActionOf(stateOf({ view: viewOf({ standing: { kind: 'insufficient', role: 'owner', units: 50 }, credits: { available: 20, recorded: 20, pending: 0 } }) }))).toMatchObject({ disabled: true })
    expect(constructionActionOf(stateOf({ view: viewOf({ standing: { kind: 'complete' } }) }))).toBeNull()
    expect(constructionActionOf(stateOf({ view: viewOf({ credits: { available: 0, recorded: 0, pending: 0 } }) }))).toBeNull()
    expect(constructionActionOf(stateOf({ view: viewOf(), busy: true }))).toMatchObject({ short: 'Building…', disabled: true })
    // An unresolved press is checked first, with the same press, whatever this property's standing.
    const press = { actionId: '0190cccc-0000-4000-8000-000000000001', worldId: WORLD, discordUserId: '1', propertyId: first, role: 'owner' as const, intent: null }
    expect(constructionActionOf(stateOf({ unresolved: press, view: viewOf({ standing: { kind: 'complete' } }) }))).toMatchObject({ role: 'owner', short: 'Check this build · same press', disabled: false })
    expect(constructionActionOf(stateOf({ unresolved: { ...press, propertyId: 'elsewhere' } }))).toMatchObject({ short: 'Check your earlier build first' })
  })

  it('opens the Architect design only for the named controller where design is open; says why to everyone else, earlier controllers and founders included', () => {
    expect(designEditable(designView())).toBe(true)
    for (const over of [{ control: 'other' as const }, { control: 'unknown' as const }, { open: false }]) expect(designEditable(designView(over)), JSON.stringify(over)).toBe(false)
    expect(designEditable(null)).toBe(false)
    expect(designEditable({ ok: false, problem: { message: 'x', kind: 'retry', code: 'world_unavailable' } })).toBe(false)
    expect(designReason(designView({ control: 'other' }), 'other', false, false)).toBe('Only its current test controller can customize its design.')
    expect(designReason(designView({ control: 'other' }), 'other', true, true)).toBe('You controlled it earlier; only its current test controller can customize its design. Founding it does not let you change it.')
    expect(designReason(designView({ control: 'unknown' }), 'unknown', false, false)).toBe('No current controller is named for this NFT, so nobody can customize it.')
    expect(designReason(designView({ open: false }), 'closed', false, false)).toBe('Property design is not open in this city on this local server.')
    expect(designReason(null, 'checking', false, false)).toBe('Reading its design…')
    expect(buildReason(stateOf({ view: viewOf({ standing: { kind: 'complete' }, property: { ...viewOf().property, tier: 2 } }) }))).toBe('Tier 2 is the highest tier this local rehearsal builds.')
    expect(buildReason(stateOf({ view: viewOf({ credits: { available: 0, recorded: 0, pending: 0 } }) }))).toMatch(/grants you no test credits here/)
    expect(buildReason(stateOf({ problem: { message: 'x', kind: 'refused', code: 'construction_not_open' } }))).toBe('Building is not open in this city yet.')
    for (const said of [
      designReason(designView({ control: 'other' }), 'other', true, true),
      designReason(designView({ control: 'unknown' }), 'unknown', false, true),
      buildReason(stateOf({ view: viewOf({ standing: { kind: 'complete' } }) })),
    ])
      expect(said).not.toMatch(OWNERSHIP)
  })
})
