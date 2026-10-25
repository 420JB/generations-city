import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FACADE_PALETTES } from '../../config/architecture'
import { tierFor, totalBuilt } from '../../game/economy'
import { parseRehearsalAppearanceResponse, parseRehearsalDesignResponse, parseRehearsalDesignView, REHEARSAL_MARK } from '../../protocol/playRehearsal'
import { BuildingSprite } from '../../ui/city/BuildingSprite'
import { CitySceneContext, sceneDistrict } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, worldBuildingId, type WorldCityState } from '../../world/cityState'
import { LOCAL_TEST_CONSTRUCTION_RECIPE, proposePropertyConstruction } from '../../world/construction'
import { ARCHITECT_DESIGN_V1, CURRENT_DESIGN_CATALOG, DESIGN_CATALOGS, isCatalogDesign, type PropertyDesign } from '../../world/design'
import { proposePropertyActivation } from '../../world/gameplay'
import { worldProperty } from '../../world/property'
import { parseBrandCityConfig } from '../core/config'
import { compileBrandWorld } from '../core/layout'
import { persistedBrandCityState, withPropertyDesigns } from '../core/persisted'
import { loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { pressBook } from './constructionPress'
import { DESIGN_REFUSALS, designBook, designSettlementOf } from './designPress'

const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'

/** A stored city with three properties at Tier 0, 1 and 2, built by the current local test recipe. */
function city(): { loaded: LoadedBrandCity; stored: WorldCityState; ids: string[] } {
  const parsed = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
  if (!parsed.ok) throw new Error('sample invalid')
  const c = parsed.config
  const compiled = compileBrandWorld(c)
  if (!compiled.ok) throw new Error('world')
  const collection = c.collections[0]
  let state: WorldCityState = emptyWorldCityState()
  let sequence = 1
  const ids: string[] = []
  for (const [i, tokenId] of ['10', '11', '12'].entries()) {
    const asset = nftAsset({ chain: collection.chain, contract: collection.contract, tokenId })!
    const next = proposePropertyActivation(compiled.world, state, sequence, { asset, plotId: `${c.districts[0].key}-w0-p${i}` })
    if (!next.ok) throw new Error(next.reason)
    state = next.transition.state
    sequence = next.transition.to
    ids.push(worldBuildingId(worldProperty(compiled.world, asset)!.propertyId))
  }
  // Tier 1 (100 units) and Tier 2 (250 units).
  for (const [id, steps] of [
    [ids[1], 2],
    [ids[2], 5],
  ] as const)
    for (let s = 0; s < steps; s++) {
      const built = proposePropertyConstruction(state, sequence, { buildingId: id, recipe: LOCAL_TEST_CONSTRUCTION_RECIPE })
      if (!built.ok) throw new Error(built.reason)
      state = built.transition.state
      sequence = built.transition.to
    }
  const loaded = loadPersistedBrandCity(c, state, compiled.world.layout.geometryFingerprint)
  if (!loaded.ok) throw new Error('load')
  return { loaded: loaded.city, stored: state, ids }
}

/** One building drawn by the city's own sprite, exactly as the map draws it up close. */
function draw(loaded: LoadedBrandCity, id: string, design: PropertyDesign | null) {
  const state = design ? withPropertyDesigns(loaded.state, { [id]: design }) : loaded.state
  const b = state.buildings[id]
  return renderToStaticMarkup(
    createElement(CitySceneContext.Provider, { value: loaded.scene }, createElement(BuildingSprite, { building: b, total: totalBuilt(b), users: {}, selected: false, isPlayer: false, isCrown: false, detail: 'near', fx: null, onSelect: () => {}, labelScale: 1, isObjective: false })),
  )
}

describe('the Architect design catalog draws through the city\'s own art (P1-C2-E4A)', () => {
  it('is one versioned catalog of identifiers the renderer already draws; its default is how every new building is drawn', () => {
    expect(CURRENT_DESIGN_CATALOG).toBe(ARCHITECT_DESIGN_V1)
    expect(Object.keys(DESIGN_CATALOGS)).toEqual(['architect-design-v1'])
    expect(ARCHITECT_DESIGN_V1.facades.every((f) => Object.hasOwn(FACADE_PALETTES, f))).toBe(true)
    expect(isCatalogDesign(ARCHITECT_DESIGN_V1, ARCHITECT_DESIGN_V1.default)).toBe(true)
    const { loaded, ids } = city()
    expect(loaded.state.buildings[ids[0]].architecture).toMatchObject(ARCHITECT_DESIGN_V1.default)
    // Exactly two catalog strings, nothing else.
    for (const bad of [{ facade: 'aurora', roof: 'flat' }, { facade: 'slate', roof: 'halo' }, { facade: 'slate', roof: 'flat', color: '#f00' }, { facade: 'slate' }, null, 'slate', ['slate', 'flat'], { facade: 1, roof: 'flat' }])
      expect(isCatalogDesign(ARCHITECT_DESIGN_V1, bad), JSON.stringify(bad)).toBe(false)
  })

  it('1-5. at Tier 0, 1 and 2 every facade is visibly distinct; from Tier 1 every roof is; the building keeps its tier, height, district and NFT label whatever the design', () => {
    const { loaded, ids } = city()
    const tiers = ids.map((id) => tierFor(totalBuilt(loaded.state.buildings[id])))
    expect(tiers).toEqual([0, 1, 2])
    for (const [i, id] of ids.entries()) {
      const plain = draw(loaded, id, null)
      const label = /#1[012] · T[012]/.exec(plain)![0]
      // Facades: each draws its own palette (the faces' colors), and only its own.
      const facades = ARCHITECT_DESIGN_V1.facades.map((facade) => draw(loaded, id, { facade, roof: 'flat' }))
      expect(new Set(facades).size).toBe(ARCHITECT_DESIGN_V1.facades.length)
      for (const [f, html] of facades.entries()) {
        const pal = FACADE_PALETTES[ARCHITECT_DESIGN_V1.facades[f]]
        expect(html).toContain(pal.left)
        expect(html).toContain(pal.right)
        expect(html).toContain(`data-facade="${ARCHITECT_DESIGN_V1.facades[f]}"`)
      }
      // Roofs: drawn from Tier 1. A Tier 0 foundation has no roof yet, so it is drawn exactly as before whatever roof is
      // saved (its label and hit area too); the choice is kept by the server and drawn once it reaches Tier 1.
      const roofs = ARCHITECT_DESIGN_V1.roofs.map((roof) => draw(loaded, id, { facade: 'slate', roof }))
      if (tiers[i] === 0) expect(new Set([plain, ...roofs]).size).toBe(1)
      else {
        expect(new Set(roofs).size).toBe(ARCHITECT_DESIGN_V1.roofs.length)
        for (const [r, html] of roofs.entries()) expect(html).toContain(`data-roof="${ARCHITECT_DESIGN_V1.roofs[r]}"`)
      }
      for (const html of [...facades, ...roofs]) {
        expect(html).toContain(`data-tier="${tiers[i]}"`)
        expect(html).toContain(`data-total="${totalBuilt(loaded.state.buildings[id])}"`)
        expect(html).toContain(label)
        // The district's identity: its color frames the NFT's label whatever the design.
        expect(html).toContain(`stroke="${sceneDistrict(loaded.scene, loaded.state.buildings[id].districtId).color}"`)
      }
    }
  })

  it('applies a design only to its building, as a new object, leaving every other building the very object it was; nothing is held or awarded for one', () => {
    const { loaded, stored, ids } = city()
    const designed = withPropertyDesigns(loaded.state, { [ids[2]]: { facade: 'copper', roof: 'spire' } })
    expect(designed.buildings[ids[2]]).not.toBe(loaded.state.buildings[ids[2]])
    expect(designed.buildings[ids[2]].architecture).toEqual({ ...loaded.state.buildings[ids[2]].architecture, facade: 'copper', roof: 'spire' })
    expect(designed.buildings[ids[2]].ownerBuilt).toBe(loaded.state.buildings[ids[2]].ownerBuilt)
    expect(designed.buildings[ids[0]]).toBe(loaded.state.buildings[ids[0]])
    expect(designed.buildings[ids[1]]).toBe(loaded.state.buildings[ids[1]])
    // Nothing that is not a catalog design of a building of the city is drawn.
    expect(withPropertyDesigns(loaded.state, { [ids[0]]: { facade: 'aurora', roof: 'halo' }, 'b-nobody': { facade: 'copper', roof: 'dome' } })).toBe(loaded.state)
    expect(withPropertyDesigns(loaded.state, { [ids[0]]: { facade: 'slate', roof: 'flat' } }).buildings[ids[0]]).toBe(loaded.state.buildings[ids[0]])
    // As the page draws it from the server: the same Crown, Capital and monuments (all vacant for local test construction).
    const all = persistedBrandCityState(loaded.config, stored, { [ids[1]]: { facade: 'jade', roof: 'terrace' }, [ids[2]]: { facade: 'brick', roof: 'dome' } })
    const plain = persistedBrandCityState(loaded.config, stored)
    expect({ crown: all.crown, capital: all.capital, monuments: all.monuments }).toEqual({ crown: plain.crown, capital: plain.capital, monuments: plain.monuments })
    expect(all.crown.holder).toBeNull()
    expect(all.capital.holder).toBeNull()
    expect(Object.values(all.monuments).every((m) => m.holder === null)).toBe(true)
    expect(all.buildings[ids[1]].architecture).toMatchObject({ facade: 'jade', roof: 'terrace' })
  })
})

/** A browser storage: what a reload of the page reads again. */
function storage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed))
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items }
}
let ids = 0
const newId = () => `0190bbbb-0000-4000-8000-${String(++ids).padStart(12, '0')}`
// This page's in-memory saves outlive a book (as they outlive a storage failure), so each test acts in its own world.
const ADA = { worldId: 'w-design-ada', discordUserId: '111111111111111111' }
const P1 = '0190bbbb-0000-8000-8000-000000000001'
const P2 = '0190bbbb-0000-8000-8000-000000000002'
const refused = (code: string | null) => ({ ok: false as const, problem: { code } })

describe('an Architect design save, kept until its answer is known', () => {
  it('only a saved design, or a refusal decided after no save was found under the id, settles a save; action_conflict ends it apart', () => {
    expect(designSettlementOf({ ok: true })).toBe('settled')
    for (const code of ['unknown_property', 'not_current_controller', 'control_unverified', 'design_not_open', 'design_unsupported', 'design_stale', 'design_unchanged']) expect(designSettlementOf(refused(code))).toBe('settled')
    expect(designSettlementOf(refused('action_conflict'))).toBe('conflict')
    for (const code of [null, 'design_unconfirmed', 'play_session_unavailable', 'world_unavailable', 'installation_unverified', 'rate_limited', 'sequence_conflict', 'play_session_required', 'play_actor_mismatch', 'invalid_request', 'mutations_held'])
      expect(designSettlementOf(refused(code)), String(code)).toBe('unknown')
  })

  it('an unresolved save is sent again exactly as first sent, whatever is chosen next; a settled one frees a new id', () => {
    const book = designBook({ ...ADA, worldId: 'w-design-2' }, storage(), newId)
    const first = book.next({ propertyId: P1, baseRevision: 0, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome' })
    expect(book.unresolved()).toEqual(first)
    // Another choice, another revision, another property: the same request, never a different design under that id.
    expect(book.next({ propertyId: P1, baseRevision: 0, catalog: 'architect-design-v1', facade: 'jade', roof: 'spire' })).toEqual(first)
    expect(book.next({ propertyId: P2, baseRevision: 4, catalog: 'architect-design-v1', facade: 'brick', roof: 'flat' })).toEqual(first)
    book.settle(first)
    expect(book.unresolved()).toBeNull()
    const second = book.next({ propertyId: P2, baseRevision: 4, catalog: 'architect-design-v1', facade: 'brick', roof: 'flat' })
    expect(second).toMatchObject({ propertyId: P2, baseRevision: 4, facade: 'brick', roof: 'flat' })
    expect(second.actionId).not.toBe(first.actionId)
  })

  it('survives a reload, is kept apart from construction presses and from other players and worlds, and ignores anything in storage that is not a save', () => {
    const kept = storage()
    const ADA3 = { ...ADA, worldId: 'w-design-3' }
    const first = designBook(ADA3, kept, newId).next({ propertyId: P1, baseRevision: 2, catalog: 'architect-design-v1', facade: 'limestone', roof: 'terrace' })
    // A reload: a new book on the same storage.
    expect(designBook(ADA3, kept, newId).unresolved()).toEqual(first)
    expect(designBook({ ...ADA3, discordUserId: '222222222222222222' }, kept, newId).unresolved()).toBeNull()
    expect(designBook({ ...ADA3, worldId: 'w-other' }, kept, newId).unresolved()).toBeNull()
    // Construction's press book neither sees nor sends it, and the reverse.
    expect(pressBook(ADA3, kept, newId).unresolved()).toBeNull()
    const press = pressBook(ADA3, kept, newId).next(P1, 'owner')
    expect(designBook(ADA3, kept, newId).unresolved()).toEqual(first)
    expect(pressBook(ADA3, kept, newId).unresolved()).toEqual(press)
    expect([...kept.items.keys()].sort()).toEqual(['rare-city-construction-presses', 'rare-city-design-saves'])
    // Kept entries that are not saves (markup, a missing field, another shape) are never sent.
    const odd = storage({
      'rare-city-design-saves': JSON.stringify([
        { ...first, worldId: 'w-design-4', actionId: newId(), facade: '<script>' },
        { ...first, worldId: 'w-design-4', actionId: newId(), baseRevision: -1 },
        { ...first, worldId: 'w-design-4', actionId: 'x' },
        { actionId: newId(), worldId: 'w-design-4', discordUserId: ADA.discordUserId },
        'junk',
      ]),
    })
    const ADA4 = { ...ADA, worldId: 'w-design-4' }
    const oddFirst = { ...first, worldId: ADA4.worldId }
    expect(designBook(ADA4, odd, newId).unresolved()).toBeNull()
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([oddFirst]) }), newId).unresolved()).toEqual(oddFirst)
    expect(designBook({ ...ADA, worldId: 'w-design-5' }, storage({ 'rare-city-design-saves': '{not json' }), newId).unresolved()).toBeNull()
  })
})

describe('the Architect design wire contract', () => {
  const catalog = { key: 'architect-design-v1', facades: [...ARCHITECT_DESIGN_V1.facades], roofs: [...ARCHITECT_DESIGN_V1.roofs], default: { facade: 'slate', roof: 'flat' } }
  const id = '0190cccc-0000-4000-8000-000000000001'
  const design = { propertyId: id, buildingId: `b-${id}`, revision: 1, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome' }
  const view = { rehearsal: REHEARSAL_MARK, catalog, property: { propertyId: id, buildingId: `b-${id}` }, saved: { revision: 1, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome', atCitySequence: 4, at: '2026-10-24T00:00:00.000Z' }, control: 'viewer', open: true, history: [{ revision: 1, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome', by: 'viewer', at: '2026-10-24T00:00:00.000Z' }], historyCount: 1 }

  it('reads only catalogs this build has, exactly, and only their choices', () => {
    expect(parseRehearsalAppearanceResponse({ rehearsal: REHEARSAL_MARK, catalog, designs: [design] })).toEqual({ rehearsal: REHEARSAL_MARK, catalog, designs: [design] })
    for (const bad of [
      { catalog: { ...catalog, key: 'architect-design-v2' } },
      { catalog: { ...catalog, facades: [...catalog.facades, 'aurora'] } },
      { catalog: { ...catalog, roofs: catalog.roofs.slice(1) } },
      { catalog: { ...catalog, default: { facade: 'jade', roof: 'flat' } } },
      { designs: [{ ...design, facade: 'aurora' }] },
      { designs: [{ ...design, facade: '<b>x</b>' }] },
      { designs: [{ ...design, catalog: 'architect-design-v2' }] },
      { designs: [{ ...design, revision: 0 }] },
      { designs: [{ ...design, buildingId: 'b-other' }] },
      { designs: [{ ...design, color: '#f00' }] },
      { designs: [design, design] },
      { extra: true },
    ])
      expect(parseRehearsalAppearanceResponse({ rehearsal: REHEARSAL_MARK, catalog, designs: [design], ...bad }), JSON.stringify(bad)).toBeNull()
  })

  it('a view and a save answer must agree with themselves', () => {
    expect(parseRehearsalDesignView(view)).toEqual(view)
    expect(parseRehearsalDesignView({ ...view, saved: null })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, historyCount: 2 })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, saved: { ...view.saved, facade: 'aurora' } })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, control: 'owner' })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, saved: null, history: [], historyCount: 0 })).toMatchObject({ saved: null })
    const answer = { rehearsal: REHEARSAL_MARK, fresh: true, design: { ...design, actionId: '0190cccc-0000-4000-8000-0000000000aa', atCitySequence: 4, designedAt: '2026-10-24T00:00:00.000Z' }, view }
    expect(parseRehearsalDesignResponse(answer)).toEqual(answer)
    expect(parseRehearsalDesignResponse({ ...answer, view: null })).toMatchObject({ view: null })
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, roof: 'halo' } })).toBeNull()
    expect(parseRehearsalDesignResponse({ ...answer, view: { ...view, property: { propertyId: P1, buildingId: `b-${P1}` } } })).toBeNull()
  })
})

describe('Architect design refusals are said as what happened to the design (audit L3)', () => {
  it('every refusal a design shares with construction or placement has its own wording: no build, spend, credit, owner or placement', () => {
    expect(Object.keys(DESIGN_REFUSALS).sort()).toEqual(['action_conflict', 'control_unverified', 'mutations_held', 'not_current_controller', 'sequence_conflict'])
    for (const [code, text] of Object.entries(DESIGN_REFUSALS)) {
      expect(text, code).not.toMatch(/\bbuil[dt]|spen[dt]|credit|owner|\bplac(e|ed|ing)\b|propert(y|ies) (is|was) placed/i)
      expect(text, code).toMatch(/design|save|change/i)
    }
  })

  it('control is LOCAL TEST control, never verified and never the founder\'s by founding; a refusal decided before writing says no revision was recorded', () => {
    for (const code of ['not_current_controller', 'control_unverified']) {
      expect(DESIGN_REFUSALS[code]).toContain('LOCAL TEST')
      expect(DESIGN_REFUSALS[code]).toContain('No design revision was recorded.')
      expect(DESIGN_REFUSALS[code]).toMatch(/this property’s design/)
    }
    expect(DESIGN_REFUSALS.not_current_controller).toMatch(/not authorized to change this property’s design/)
    expect(DESIGN_REFUSALS.not_current_controller).toMatch(/Founding a property, or contributing to it as a patron, does not grant that/)
    expect(DESIGN_REFUSALS.control_unverified).toMatch(/could not be established/)
    expect(DESIGN_REFUSALS.mutations_held).toMatch(/not available in this city/)
  })

  it('an outcome the page cannot know is never said to have saved nothing, and a conflicting id claims nothing about the other save', () => {
    for (const code of ['sequence_conflict', 'action_conflict']) expect(DESIGN_REFUSALS[code], code).not.toMatch(/nothing (was|is) saved|no design revision was recorded|was saved|succeeded/i)
    expect(DESIGN_REFUSALS.sequence_conflict).toMatch(/Check this save again, with the same request/)
    expect(DESIGN_REFUSALS.action_conflict).toMatch(/How that other save went is not known here/)
  })
})
