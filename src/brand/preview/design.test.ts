import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHITECTURE, FACADE_PALETTES, LIGHTING_COLORS } from '../../config/architecture'
import { tierFor, totalBuilt } from '../../game/economy'
import { parseRehearsalAppearanceResponse, parseRehearsalDesignResponse, parseRehearsalDesignView, REHEARSAL_MARK } from '../../protocol/playRehearsal'
import { BuildingSprite } from '../../ui/city/BuildingSprite'
import { CitySceneContext, sceneDistrict } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, worldBuildingId, type WorldCityState } from '../../world/cityState'
import { LOCAL_TEST_CONSTRUCTION_RECIPE, proposePropertyConstruction } from '../../world/construction'
import { appearanceOf, ARCHITECT_DESIGN_V1, ARCHITECT_DESIGN_V2, ARCHITECT_DESIGN_V3, CURRENT_DESIGN_CATALOG, DESIGN_CATALOGS, isCatalogChoice, isDrawableDesign, LEGACY_DETAILS, sameDesign, type PropertyDesign } from '../../world/design'
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

/** One building drawn by the city's own sprite, exactly as the map draws it (up close unless `detail` says otherwise). */
function draw(loaded: LoadedBrandCity, id: string, design: PropertyDesign | null, detail: 'far' | 'mid' | 'near' = 'near') {
  const state = design ? withPropertyDesigns(loaded.state, { [id]: design }) : loaded.state
  const b = state.buildings[id]
  return renderToStaticMarkup(
    createElement(CitySceneContext.Provider, { value: loaded.scene }, createElement(BuildingSprite, { building: b, total: totalBuilt(b), users: {}, selected: false, isPlayer: false, isCrown: false, detail, fx: null, onSelect: () => {}, labelScale: 1, isObjective: false })),
  )
}
/** A whole design: the given slots, the catalog default for the rest. */
const D = (d: Partial<PropertyDesign>): PropertyDesign => ({ ...ARCHITECT_DESIGN_V3.default, ...d })
/** A v1 and a v2 choice as their rows record them: null for every slot their catalog does not have. */
const V1C = (facade: string, roof: string) => ({ facade, roof, windows: null, lighting: null, entrance: null, landscaping: null })
const V2C = (facade: string, roof: string, windows: string, lighting: string) => ({ facade, roof, windows, lighting, entrance: null, landscaping: null })

describe('the Architect design catalog draws through the city\'s own art (P1-C2-E4A)', () => {
  it('is a versioned catalog of identifiers the renderer already draws; its default is how every new building is drawn', () => {
    expect(ARCHITECT_DESIGN_V1.facades.every((f) => Object.hasOwn(FACADE_PALETTES, f))).toBe(true)
    // v1 chose a facade and a roof only: its choices name no windows or lighting.
    expect(isCatalogChoice(ARCHITECT_DESIGN_V1, V1C('slate', 'flat'))).toBe(true)
    expect(ARCHITECT_DESIGN_V1.default).toEqual({ facade: 'slate', roof: 'flat', ...LEGACY_DETAILS })
    const { loaded, ids } = city()
    expect(loaded.state.buildings[ids[0]].architecture).toMatchObject({ facade: 'slate', roof: 'flat' })
    // Exactly the catalog's strings, nothing else.
    for (const bad of [{ facade: 'aurora', roof: 'flat' }, { facade: 'slate', roof: 'halo' }, { facade: 'slate', roof: 'flat', color: '#f00' }, { facade: 'slate' }, null, 'slate', ['slate', 'flat'], { facade: 1, roof: 'flat' }])
      for (const extra of [{}, { windows: null, lighting: null }, { windows: null, lighting: null, entrance: null, landscaping: null }])
        expect(isCatalogChoice(ARCHITECT_DESIGN_V1, bad && typeof bad === 'object' && !Array.isArray(bad) ? { ...bad, ...extra } : bad), JSON.stringify(bad)).toBe(false)
  })

  it('1-5. at Tier 0, 1 and 2 every facade is visibly distinct; from Tier 1 every roof is; the building keeps its tier, height, district and NFT label whatever the design', () => {
    const { loaded, ids } = city()
    const tiers = ids.map((id) => tierFor(totalBuilt(loaded.state.buildings[id])))
    expect(tiers).toEqual([0, 1, 2])
    for (const [i, id] of ids.entries()) {
      const plain = draw(loaded, id, null)
      const label = /#1[012] · T[012]/.exec(plain)![0]
      // Facades: each draws its own palette (the faces' colors), and only its own.
      const facades = ARCHITECT_DESIGN_V1.facades.map((facade) => draw(loaded, id, D({ facade })))
      expect(new Set(facades).size).toBe(ARCHITECT_DESIGN_V1.facades.length)
      for (const [f, html] of facades.entries()) {
        const pal = FACADE_PALETTES[ARCHITECT_DESIGN_V1.facades[f]]
        expect(html).toContain(pal.left)
        expect(html).toContain(pal.right)
        expect(html).toContain(`data-facade="${ARCHITECT_DESIGN_V1.facades[f]}"`)
      }
      // Roofs: drawn from Tier 1. A Tier 0 foundation has no roof yet, so it is drawn exactly as before whatever roof is
      // saved (its label and hit area too); the choice is kept by the server and drawn once it reaches Tier 1.
      const roofs = ARCHITECT_DESIGN_V1.roofs.map((roof) => draw(loaded, id, D({ roof })))
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
    const designed = withPropertyDesigns(loaded.state, { [ids[2]]: D({ facade: 'copper', roof: 'spire' }) })
    expect(designed.buildings[ids[2]]).not.toBe(loaded.state.buildings[ids[2]])
    expect(designed.buildings[ids[2]].architecture).toEqual({ ...loaded.state.buildings[ids[2]].architecture, facade: 'copper', roof: 'spire' })
    expect(designed.buildings[ids[2]].ownerBuilt).toBe(loaded.state.buildings[ids[2]].ownerBuilt)
    expect(designed.buildings[ids[0]]).toBe(loaded.state.buildings[ids[0]])
    expect(designed.buildings[ids[1]]).toBe(loaded.state.buildings[ids[1]])
    // Nothing that is not a catalog design of a building of the city is drawn.
    const odd = (d: object) => d as PropertyDesign
    expect(
      withPropertyDesigns(loaded.state, {
        [ids[0]]: D({ facade: 'aurora', roof: 'halo' }),
        [ids[1]]: D({ windows: 'panoramic' }),
        [ids[2]]: D({ lighting: 'neon' }),
        'b-nobody': D({ facade: 'copper', roof: 'dome' }),
      }),
    ).toBe(loaded.state)
    for (const bad of [{ facade: 'copper', roof: 'dome' }, { ...D({}), windows: null }, { ...D({}), color: '#f00' }, { ...D({}), lighting: 'url(#x)' }])
      expect(withPropertyDesigns(loaded.state, { [ids[1]]: odd(bad) }), JSON.stringify(bad)).toBe(loaded.state)
    expect(withPropertyDesigns(loaded.state, { [ids[0]]: D({}) }).buildings[ids[0]]).toBe(loaded.state.buildings[ids[0]])
    // As the page draws it from the server: the same Crown, Capital and monuments (all vacant for local test construction).
    const all = persistedBrandCityState(loaded.config, stored, { [ids[1]]: D({ facade: 'jade', roof: 'terrace', lighting: 'warm' }), [ids[2]]: D({ facade: 'brick', roof: 'dome', windows: 'ribbon', lighting: 'cool' }) })
    const plain = persistedBrandCityState(loaded.config, stored)
    expect({ crown: all.crown, capital: all.capital, monuments: all.monuments }).toEqual({ crown: plain.crown, capital: plain.capital, monuments: plain.monuments })
    expect(all.crown.holder).toBeNull()
    expect(all.capital.holder).toBeNull()
    expect(Object.values(all.monuments).every((m) => m.holder === null)).toBe(true)
    expect(all.buildings[ids[1]].architecture).toMatchObject({ facade: 'jade', roof: 'terrace' })
    expect(all.buildings[ids[2]].architecture).toMatchObject({ facade: 'brick', roof: 'dome', windows: 'ribbon', lighting: 'cool' })
    // The tier and progress drawn are the stored city's, whatever the design.
    for (const id of ids) expect(all.buildings[id].ownerBuilt).toBe(plain.buildings[id].ownerBuilt)
  })
})

describe('Architect windows and exterior lighting (P1-C2-E4B)', () => {
  it('catalog v2 (read only since v3): v1\'s facades and roofs, plus windows and lighting the renderer already draws; v1 stays readable', () => {
    expect(Object.keys(DESIGN_CATALOGS)).toEqual(['architect-design-v1', 'architect-design-v2', 'architect-design-v3'])
    expect(ARCHITECT_DESIGN_V2.slots).toEqual(['facade', 'roof', 'windows', 'lighting'])
    expect(ARCHITECT_DESIGN_V2.facades).toEqual(ARCHITECT_DESIGN_V1.facades)
    expect(ARCHITECT_DESIGN_V2.roofs).toEqual(ARCHITECT_DESIGN_V1.roofs)
    expect(ARCHITECT_DESIGN_V2.windows).toEqual(['grid', 'arched', 'ribbon', 'lattice'])
    expect(ARCHITECT_DESIGN_V2.lighting).toEqual(['standard', 'warm', 'cool'])
    // The default is exactly how every building was drawn before v2: the renderer's default windows and warm glow.
    expect(ARCHITECT_DESIGN_V2.default).toEqual(ARCHITECT_DESIGN_V1.default)
    expect(DEFAULT_ARCHITECTURE).toMatchObject({ windows: ARCHITECT_DESIGN_V2.default.windows, lighting: 'warm' })
    expect(isCatalogChoice(ARCHITECT_DESIGN_V2, { ...ARCHITECT_DESIGN_V2.default, entrance: null, landscaping: null })).toBe(true)
    // A v2 choice names its four; a v1 choice names no treatment; neither accepts the other's shape.
    const v2 = V2C('brick', 'dome', 'ribbon', 'cool')
    expect(isCatalogChoice(ARCHITECT_DESIGN_V2, v2)).toBe(true)
    expect(isCatalogChoice(ARCHITECT_DESIGN_V1, v2)).toBe(false)
    expect(isCatalogChoice(ARCHITECT_DESIGN_V2, { ...v2, windows: null, lighting: null })).toBe(false)
    for (const bad of [{ ...v2, windows: 'panoramic' }, { ...v2, lighting: 'neon' }, { ...v2, lighting: 'gold' }, { ...v2, windows: null }, { ...v2, lighting: '#ffcc00' }, { facade: 'brick', roof: 'dome' }, { ...v2, glow: 'x' }])
      expect(isCatalogChoice(ARCHITECT_DESIGN_V2, bad), JSON.stringify(bad)).toBe(false)
    // A v1 choice is drawn with the treatments it was saved with.
    expect(appearanceOf(V1C('jade', 'spire'))).toEqual({ facade: 'jade', roof: 'spire', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' })
    expect(isDrawableDesign(appearanceOf(V1C('jade', 'spire')))).toBe(true)
    expect(sameDesign(appearanceOf(V1C('jade', 'spire')), D({ facade: 'jade', roof: 'spire' }))).toBe(true)
  })

  it('1, 6. the default and any v1 design draw a building exactly as before: no floodlights, the standard windows and glow', () => {
    const { loaded, ids } = city()
    for (const id of ids) {
      expect(withPropertyDesigns(loaded.state, { [id]: ARCHITECT_DESIGN_V2.default }).buildings[id]).toBe(loaded.state.buildings[id])
      for (const detail of ['far', 'mid', 'near'] as const) {
        const plain = draw(loaded, id, null, detail)
        expect(draw(loaded, id, ARCHITECT_DESIGN_V2.default, detail)).toBe(plain)
        expect(plain).not.toContain('data-floodlight')
        // A v1 brick / dome is drawn exactly as a v2 brick / dome with the standard treatments.
        expect(draw(loaded, id, appearanceOf(V1C('brick', 'dome')), detail)).toBe(draw(loaded, id, D({ facade: 'brick', roof: 'dome' }), detail))
      }
    }
  })

  it('3, 4, 6-8. from Tier 1 every window and every lighting treatment draws distinctly, on the same tier, label, district and facade; a Tier 0 foundation draws none yet', () => {
    const { loaded, ids } = city()
    const tiers = ids.map((id) => tierFor(totalBuilt(loaded.state.buildings[id])))
    for (const [i, id] of ids.entries()) {
      const plain = draw(loaded, id, null)
      const label = /#1[012] · T[012]/.exec(plain)![0]
      const windows = ARCHITECT_DESIGN_V2.windows.map((w) => draw(loaded, id, D({ windows: w })))
      const lighting = ARCHITECT_DESIGN_V2.lighting.map((l) => draw(loaded, id, D({ lighting: l })))
      if (tiers[i] === 0) {
        // No storeys yet: windows and lighting are kept by the server and drawn from Tier 1.
        expect(new Set([plain, ...windows]).size).toBe(1)
        for (const html of lighting) expect(html).not.toContain('data-floodlight')
      } else {
        expect(new Set(windows).size).toBe(ARCHITECT_DESIGN_V2.windows.length)
        for (const [w, html] of windows.entries()) expect(html).toContain(`url(#win-${ARCHITECT_DESIGN_V2.windows[w]}-warm)`)
        expect(new Set(lighting).size).toBe(ARCHITECT_DESIGN_V2.lighting.length)
        // standard: warm glow, no floodlights; warm: warm glow and warm floodlights; cool: cool glow and cool floodlights.
        expect(lighting[0]).toBe(plain)
        expect(lighting[1]).toContain('data-floodlights="warm"')
        expect(lighting[1]).toContain(`fill="${LIGHTING_COLORS.warm.accent}"`)
        expect(lighting[1]).toContain('url(#win-grid-warm)')
        expect(lighting[2]).toContain('data-floodlights="cool"')
        expect(lighting[2]).toContain(`fill="${LIGHTING_COLORS.cool.accent}"`)
        expect(lighting[2]).toContain('url(#win-grid-cool)')
        // Lit cornice and uplight beams, both static: no animation class, filter or gradient of their own.
        for (const html of lighting.slice(1)) {
          expect(html).toContain('data-floodlight-face')
          const lights = html.match(/<g pointer-events="none" data-floodlight-face="[^"]*">.*?<\/g>/g) ?? []
          expect(lights.length).toBeGreaterThanOrEqual(2)
          for (const g of lights) expect(g).not.toMatch(/class=|filter|url\(|animate/)
        }
      }
      for (const html of [...windows, ...lighting]) {
        expect(html).toContain(`data-tier="${tiers[i]}"`)
        expect(html).toContain(label)
        expect(html).toContain(`stroke="${sceneDistrict(loaded.scene, loaded.state.buildings[id].districtId).color}"`)
        expect(html).toContain(FACADE_PALETTES.slate.left)
      }
    }
  })

  it('5. a whole design (facade, roof, windows, lighting) draws all four together; distance draws less of the lighting, never more', () => {
    const { loaded, ids } = city()
    const whole = D({ facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool' })
    const near = draw(loaded, ids[2], whole, 'near')
    for (const s of ['data-facade="copper"', 'data-roof="spire"', 'url(#win-lattice-cool)', 'data-floodlights="cool"', FACADE_PALETTES.copper.left]) expect(near).toContain(s)
    const count = (html: string, s: string) => html.split(s).length - 1
    const mid = draw(loaded, ids[2], whole, 'mid')
    const far = draw(loaded, ids[2], whole, 'far')
    // Near: beams, fixtures and cornice. Mid: beams and cornice. Far: the cornice only.
    expect(count(near, 'fill="#fff4cf"')).toBeGreaterThan(count(mid, 'fill="#fff4cf"'))
    expect(count(mid, 'data-floodlight-face="wash')).toBeGreaterThan(0)
    expect(count(far, 'data-floodlight-face="wash')).toBe(0)
    expect(count(far, 'data-floodlight-face="cornice"')).toBe(2)
    expect(far.length).toBeLessThan(mid.length)
    // Never a pointer target: the building's hit area stays the first, unchanged element.
    const hit = (html: string) => /<rect[^>]*fill="transparent"[^>]*>/.exec(html)![0]
    expect(hit(near)).toBe(hit(draw(loaded, ids[2], D({ facade: 'copper', roof: 'spire' }), 'near')))
  })
})

describe('Architect entrances and landscaping (P1-C2-E4C)', () => {
  const hit = (html: string) => /<rect[^>]*fill="transparent"[^>]*>/.exec(html)![0]
  const label = (html: string) => /<g id="bl-[^"]*" transform="[^"]*"/.exec(html)?.[0] ?? ''

  it('catalog v3 is current: v2\'s four categories, plus entrances and landscaping the renderer already draws; v1 and v2 stay readable', () => {
    expect(CURRENT_DESIGN_CATALOG).toBe(ARCHITECT_DESIGN_V3)
    expect(ARCHITECT_DESIGN_V3.slots).toEqual(['facade', 'roof', 'windows', 'lighting', 'entrance', 'landscaping'])
    for (const k of ['facades', 'roofs', 'windows', 'lighting'] as const) expect(ARCHITECT_DESIGN_V3[k]).toEqual(ARCHITECT_DESIGN_V2[k])
    expect(ARCHITECT_DESIGN_V3.entrances).toEqual(['standard', 'canopy', 'arched', 'portico'])
    expect(ARCHITECT_DESIGN_V3.landscaping).toEqual(['standard', 'garden', 'courtyard'])
    // The default is exactly how every building was drawn before v3: the standard door, bare paving.
    expect(ARCHITECT_DESIGN_V3.default).toEqual(ARCHITECT_DESIGN_V2.default)
    expect(LEGACY_DETAILS).toMatchObject({ entrance: 'standard', landscaping: 'standard' })
    expect(isCatalogChoice(ARCHITECT_DESIGN_V3, ARCHITECT_DESIGN_V3.default)).toBe(true)
    // A v3 choice names all six; earlier catalogs' choices are not v3's, nor the reverse.
    const v3 = { facade: 'jade', roof: 'dome', windows: 'arched', lighting: 'warm', entrance: 'portico', landscaping: 'garden' }
    expect(isCatalogChoice(ARCHITECT_DESIGN_V3, v3)).toBe(true)
    expect(isCatalogChoice(ARCHITECT_DESIGN_V2, v3)).toBe(false)
    expect(isCatalogChoice(ARCHITECT_DESIGN_V3, V2C('jade', 'dome', 'arched', 'warm'))).toBe(false)
    expect(isCatalogChoice(ARCHITECT_DESIGN_V3, V1C('jade', 'dome'))).toBe(false)
    for (const bad of [
      { ...v3, entrance: 'awning' },
      { ...v3, entrance: 'grand-portico' },
      { ...v3, landscaping: 'none' },
      { ...v3, landscaping: 'pond' },
      { ...v3, landscaping: null },
      { ...v3, entrance: '<a href=x>' },
      { ...v3, pieces: [{ x: 1, y: 2 }] },
      { facade: 'jade', roof: 'dome', windows: 'arched', lighting: 'warm' },
    ])
      expect(isCatalogChoice(ARCHITECT_DESIGN_V3, bad), JSON.stringify(bad)).toBe(false)
    // A v2 choice is drawn with the standard entrance and grounds it was saved with.
    expect(appearanceOf(V2C('brick', 'spire', 'ribbon', 'cool'))).toEqual(D({ facade: 'brick', roof: 'spire', windows: 'ribbon', lighting: 'cool' }))
  })

  it('1-3. the default, and any v1 or v2 design, draw a building exactly as E4B did: no entrance or grounds of their own', () => {
    const { loaded, ids } = city()
    for (const id of ids) {
      expect(withPropertyDesigns(loaded.state, { [id]: ARCHITECT_DESIGN_V3.default }).buildings[id]).toBe(loaded.state.buildings[id])
      for (const detail of ['far', 'mid', 'near'] as const) {
        const plain = draw(loaded, id, null, detail)
        expect(draw(loaded, id, ARCHITECT_DESIGN_V3.default, detail)).toBe(plain)
        expect(plain).not.toMatch(/data-entrance|data-grounds/)
        expect(draw(loaded, id, appearanceOf(V1C('copper', 'dome')), detail)).toBe(draw(loaded, id, D({ facade: 'copper', roof: 'dome' }), detail))
        const v2 = appearanceOf(V2C('copper', 'dome', 'lattice', 'cool'))
        expect(draw(loaded, id, v2, detail)).not.toMatch(/data-entrance|data-grounds/)
        expect(draw(loaded, id, v2, detail)).toBe(draw(loaded, id, D({ facade: 'copper', roof: 'dome', windows: 'lattice', lighting: 'cool' }), detail))
      }
      expect(withPropertyDesigns(loaded.state, { [id]: appearanceOf(V2C('copper', 'dome', 'lattice', 'cool')) }).buildings[id]).not.toHaveProperty('street')
    }
  })

  it('5, 9-11. from Tier 1 every entrance draws distinctly on the podium, on the same tier, label, district and hit area; a Tier 0 foundation draws none yet', () => {
    const { loaded, ids } = city()
    const tiers = ids.map((id) => tierFor(totalBuilt(loaded.state.buildings[id])))
    const kinds: Record<string, string> = { canopy: 'awning', arched: 'arch', portico: 'grand-portico' }
    for (const [i, id] of ids.entries()) {
      const plain = draw(loaded, id, null)
      const entrances = ARCHITECT_DESIGN_V3.entrances.map((entrance) => draw(loaded, id, D({ entrance })))
      expect(entrances[0]).toBe(plain)
      if (tiers[i] === 0) {
        // No storeys yet: the choice is kept by the server, and drawn from Tier 1. Until then the foundation is drawn exactly as before.
        for (const html of entrances.slice(1)) expect(html).toBe(plain)
        continue
      }
      expect(new Set(entrances).size).toBe(ARCHITECT_DESIGN_V3.entrances.length)
      for (const [e, html] of entrances.entries()) {
        const entrance = ARCHITECT_DESIGN_V3.entrances[e]
        if (entrance !== 'standard') expect(html).toContain(`data-entrance="${kinds[entrance]}"`)
        expect(html).toContain(`data-tier="${tiers[i]}"`)
        expect(html).toContain(/#1[012] · T[012]/.exec(plain)![0])
        expect(html).toContain(`stroke="${sceneDistrict(loaded.scene, loaded.state.buildings[id].districtId).color}"`)
        expect(hit(html)).toBe(hit(plain))
        expect(label(html)).toBe(label(plain))
      }
      // The portico closes up to the podium's face (never overhanging it), at its full height.
      expect(entrances[3]).toMatch(/<g transform="matrix\(0\.[67]\d\d 0 0 1 [\d.]+ 0\)">/)
      // Canopy and arch: the renderer's own awning and arch.
      expect(entrances[1]).toMatch(/<polygon points="[^"]*"/)
      expect(entrances[2]).toMatch(/A6\.5 6\.5/)
    }
  })

  it('6, 9-11. from Tier 1 every landscaping treatment draws distinctly on the paved lot (near and mid), never a pointer target or animation; distance drops it; Tier 0 draws none', () => {
    const { loaded, ids } = city()
    const tiers = ids.map((id) => tierFor(totalBuilt(loaded.state.buildings[id])))
    const pieces = (html: string) => (html.match(/data-grounds-piece="([a-z]+)"/g) ?? []).map((m) => m.slice(20, -1))
    for (const [i, id] of ids.entries()) {
      for (const detail of ['near', 'mid'] as const) {
        const plain = draw(loaded, id, null, detail)
        const drawn = ARCHITECT_DESIGN_V3.landscaping.map((landscaping) => draw(loaded, id, D({ landscaping }), detail))
        expect(drawn[0]).toBe(plain)
        if (tiers[i] === 0) {
          for (const html of drawn) expect(html).toBe(plain)
          continue
        }
        expect(new Set(drawn).size).toBe(3)
        expect(pieces(drawn[1])).toEqual(['tree', 'shrub', 'tree', 'planter', 'shrub', 'planter'])
        expect(pieces(drawn[2])).toEqual(['lamp', 'shrub', 'lamp', 'planter', 'planter', 'bench'])
        for (const html of drawn.slice(1)) {
          expect(hit(html)).toBe(hit(plain))
          expect(label(html)).toBe(label(plain))
          const grounds = /<g pointer-events="none" data-grounds-pieces="[a-z]+">.*?<\/g><\/g><\/g>/.exec(html)
          expect(grounds).not.toBeNull()
          expect(grounds![0]).not.toMatch(/class="(?!ls-tree")|filter|animate/)
        }
      }
      // Far: no pieces at all (the overview stays as light as before).
      const far = draw(loaded, id, D({ landscaping: 'garden' }), 'far')
      expect(pieces(far)).toEqual([])
      if (tiers[i] === 0) expect(far).toBe(draw(loaded, id, null, 'far'))
      else expect(far.replace(/ data-entrance="simple" data-grounds="garden"/, '')).toBe(draw(loaded, id, null, 'far'))
    }
  })

  it('12. a whole design draws all six categories together, on the one building, and nothing else changes', () => {
    const { loaded, ids } = city()
    const whole = D({ facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'warm', entrance: 'portico', landscaping: 'courtyard' })
    const html = draw(loaded, ids[2], whole)
    for (const s of ['data-facade="jade"', 'data-roof="dome"', 'url(#win-ribbon-warm)', 'data-floodlights="warm"', 'data-entrance="grand-portico"', 'data-grounds="courtyard"', FACADE_PALETTES.jade.left]) expect(html).toContain(s)
    const designed = withPropertyDesigns(loaded.state, { [ids[2]]: whole })
    expect(designed.buildings[ids[2]].street).toEqual({ entrance: 'grand-portico', grounds: 'courtyard' })
    expect(designed.buildings[ids[2]].architecture).toEqual({ ...loaded.state.buildings[ids[2]].architecture, facade: 'jade', roof: 'dome', windows: 'ribbon' })
    for (const k of ['id', 'districtId', 'ward', 'plot', 'friendId', 'ownerBuilt', 'patrons', 'fixtures', 'landscapeSlots', 'landscapeInventory', 'billboard'] as const) expect(designed.buildings[ids[2]][k]).toEqual(loaded.state.buildings[ids[2]][k])
    expect(designed.buildings[ids[0]]).toBe(loaded.state.buildings[ids[0]])
    // Back to the standard street level: the key goes, exactly as before.
    const back = withPropertyDesigns(designed, { [ids[2]]: D({ facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'warm' }) })
    expect(back.buildings[ids[2]]).not.toHaveProperty('street')
    // Nothing that is not a catalog design is drawn.
    const odd = (d: object) => d as PropertyDesign
    for (const bad of [D({ entrance: 'awning' }), D({ landscaping: 'garden-xl' }), odd({ ...D({}), entrance: null }), odd({ ...D({}), landscaping: '<g/>' })])
      expect(withPropertyDesigns(loaded.state, { [ids[1]]: bad }), JSON.stringify(bad)).toBe(loaded.state)
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
    for (const code of ['unknown_property', 'not_current_controller', 'control_unverified', 'design_not_open', 'design_unsupported', 'design_retired', 'design_stale', 'design_unchanged']) expect(designSettlementOf(refused(code))).toBe('settled')
    expect(designSettlementOf(refused('action_conflict'))).toBe('conflict')
    for (const code of [null, 'design_unconfirmed', 'play_session_unavailable', 'world_unavailable', 'installation_unverified', 'rate_limited', 'sequence_conflict', 'play_session_required', 'play_actor_mismatch', 'invalid_request', 'mutations_held'])
      expect(designSettlementOf(refused(code)), String(code)).toBe('unknown')
  })

  it('an unresolved save is sent again exactly as first sent, whatever is chosen next; a settled one frees a new id', () => {
    const book = designBook({ ...ADA, worldId: 'w-design-2' }, storage(), newId)
    const first = book.next({ propertyId: P1, baseRevision: 0, catalog: 'architect-design-v3', facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard', entrance: 'canopy', landscaping: 'garden' })
    expect(book.unresolved()).toEqual(first)
    // Another choice, another revision, another property: the same request, never a different design under that id.
    expect(book.next({ propertyId: P1, baseRevision: 0, catalog: 'architect-design-v3', facade: 'jade', roof: 'spire', windows: 'ribbon', lighting: 'warm', entrance: 'portico', landscaping: 'courtyard' })).toEqual(first)
    expect(book.next({ propertyId: P2, baseRevision: 4, catalog: 'architect-design-v3', facade: 'brick', roof: 'flat', windows: 'lattice', lighting: 'cool', entrance: 'arched', landscaping: 'standard' })).toEqual(first)
    book.settle(first)
    expect(book.unresolved()).toBeNull()
    const second = book.next({ propertyId: P2, baseRevision: 4, catalog: 'architect-design-v3', facade: 'brick', roof: 'flat', windows: 'lattice', lighting: 'cool', entrance: 'arched', landscaping: 'standard' })
    expect(second).toMatchObject({ propertyId: P2, baseRevision: 4, facade: 'brick', roof: 'flat' })
    expect(second.actionId).not.toBe(first.actionId)
  })

  it('survives a reload, is kept apart from construction presses and from other players and worlds, and ignores anything in storage that is not a save', () => {
    const kept = storage()
    const ADA3 = { ...ADA, worldId: 'w-design-3' }
    const first = designBook(ADA3, kept, newId).next({ propertyId: P1, baseRevision: 2, catalog: 'architect-design-v3', facade: 'limestone', roof: 'terrace', windows: 'arched', lighting: 'warm', entrance: 'standard', landscaping: 'garden' })
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
    // Half a treatment is not a save either, nor a street level without windows and lighting.
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([{ ...oddFirst, lighting: undefined }]) }), newId).unresolved()).toBeNull()
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([{ ...oddFirst, windows: '<b>' }]) }), newId).unresolved()).toBeNull()
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([{ ...oddFirst, landscaping: undefined }]) }), newId).unresolved()).toBeNull()
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([{ ...oddFirst, entrance: 'url(#x)' }]) }), newId).unresolved()).toBeNull()
    expect(designBook(ADA4, storage({ 'rare-city-design-saves': JSON.stringify([{ ...oddFirst, windows: undefined, lighting: undefined }]) }), newId).unresolved()).toBeNull()
  })

  it('21-22. a save an earlier page kept (catalog v1, no windows or lighting) is still a save, and is sent again exactly as kept: never a later catalog\'s save', () => {
    const ADA6 = { ...ADA, worldId: 'w-design-6' }
    // Exactly what the E4A page kept in this browser before a lost answer.
    const legacy = { actionId: newId(), worldId: ADA6.worldId, discordUserId: ADA6.discordUserId, propertyId: P1, baseRevision: 1, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome' }
    const kept = storage({ 'rare-city-design-saves': JSON.stringify([legacy]) })
    const book = designBook(ADA6, kept, newId)
    expect(book.unresolved()).toEqual(legacy)
    expect(Object.keys(book.unresolved()!)).not.toContain('windows')
    // Whatever is chosen now, the kept save goes first, unchanged: no window or lighting treatment is added to it.
    const sent = book.next({ propertyId: P1, baseRevision: 1, catalog: 'architect-design-v3', facade: 'jade', roof: 'spire', windows: 'ribbon', lighting: 'cool', entrance: 'canopy', landscaping: 'garden' })
    expect(sent).toEqual(legacy)
    expect(JSON.stringify(sent)).toBe(JSON.stringify(legacy))
    // A reload reads it back the same; settling it (its receipt, or design_retired) frees a current save under a new id.
    expect(designBook(ADA6, kept, newId).unresolved()).toEqual(legacy)
    book.settle(sent)
    const next = designBook(ADA6, kept, newId).next({ propertyId: P1, baseRevision: 1, catalog: 'architect-design-v3', facade: 'jade', roof: 'spire', windows: 'ribbon', lighting: 'cool', entrance: 'canopy', landscaping: 'garden' })
    expect(next).toMatchObject({ catalog: 'architect-design-v3', windows: 'ribbon', lighting: 'cool', entrance: 'canopy', landscaping: 'garden' })
    expect(next.actionId).not.toBe(legacy.actionId)
    // Nothing of a session is kept: only which request to repeat.
    expect(Object.keys(next).sort()).toEqual(['actionId', 'baseRevision', 'catalog', 'discordUserId', 'entrance', 'facade', 'landscaping', 'lighting', 'propertyId', 'roof', 'windows', 'worldId'])
  })

  it('27-28. a save the E4B page kept (catalog v2, no entrance or landscaping) is sent again exactly as kept: never a v3 save', () => {
    const ADA7 = { ...ADA, worldId: 'w-design-7' }
    // Exactly what the E4B page kept in this browser before a lost answer.
    const kept2 = { actionId: newId(), worldId: ADA7.worldId, discordUserId: ADA7.discordUserId, propertyId: P2, baseRevision: 2, catalog: 'architect-design-v2', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'warm' }
    const kept = storage({ 'rare-city-design-saves': JSON.stringify([kept2]) })
    const book = designBook(ADA7, kept, newId)
    expect(book.unresolved()).toEqual(kept2)
    // Whatever is chosen now, it goes first, byte for byte: no entrance or landscaping is added to it.
    const sent = book.next({ propertyId: P2, baseRevision: 2, catalog: 'architect-design-v3', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'warm', entrance: 'portico', landscaping: 'courtyard' })
    expect(JSON.stringify(sent)).toBe(JSON.stringify(kept2))
    expect(Object.keys(sent)).not.toContain('entrance')
    expect(JSON.stringify(designBook(ADA7, kept, newId).unresolved())).toBe(JSON.stringify(kept2))
    book.settle(sent)
    const next = designBook(ADA7, kept, newId).next({ propertyId: P2, baseRevision: 2, catalog: 'architect-design-v3', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'warm', entrance: 'portico', landscaping: 'courtyard' })
    expect(next).toMatchObject({ catalog: 'architect-design-v3', entrance: 'portico', landscaping: 'courtyard' })
    expect(next.actionId).not.toBe(kept2.actionId)
  })
})

describe('the Architect design wire contract', () => {
  const catalog = {
    key: 'architect-design-v3',
    facades: [...ARCHITECT_DESIGN_V3.facades],
    roofs: [...ARCHITECT_DESIGN_V3.roofs],
    windows: [...ARCHITECT_DESIGN_V3.windows],
    lighting: [...ARCHITECT_DESIGN_V3.lighting],
    entrances: [...ARCHITECT_DESIGN_V3.entrances],
    landscaping: [...ARCHITECT_DESIGN_V3.landscaping],
    default: { facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' },
  }
  const id = '0190cccc-0000-4000-8000-000000000001'
  const v1 = { catalog: 'architect-design-v1', ...V1C('copper', 'dome') }
  const v2 = { catalog: 'architect-design-v2', ...V2C('brick', 'spire', 'ribbon', 'cool') }
  const v3 = { catalog: 'architect-design-v3', facade: 'jade', roof: 'terrace', windows: 'arched', lighting: 'warm', entrance: 'portico', landscaping: 'garden' }
  const design = { propertyId: id, buildingId: `b-${id}`, revision: 1, ...v1 }
  const at = '2026-10-24T00:00:00.000Z'
  const view = { rehearsal: REHEARSAL_MARK, catalog, property: { propertyId: id, buildingId: `b-${id}` }, saved: { revision: 1, ...v1, atCitySequence: 4, at }, control: 'viewer', open: true, history: [{ revision: 1, ...v1, by: 'viewer', at }], historyCount: 1 }

  it('reads only catalogs this build has, exactly, and only their choices: a v1 design names no treatment, a v2 design its four, a v3 design all six', () => {
    expect(parseRehearsalAppearanceResponse({ rehearsal: REHEARSAL_MARK, catalog, designs: [design] })).toEqual({ rehearsal: REHEARSAL_MARK, catalog, designs: [design] })
    const second = { ...design, propertyId: P1, buildingId: `b-${P1}`, revision: 3, ...v2 }
    const third = { ...design, propertyId: P2, buildingId: `b-${P2}`, revision: 4, ...v3 }
    expect(parseRehearsalAppearanceResponse({ rehearsal: REHEARSAL_MARK, catalog, designs: [design, second, third] })).toMatchObject({ designs: [design, second, third] })
    for (const bad of [
      { catalog: { ...catalog, key: 'architect-design-v4' } },
      { catalog: { ...catalog, key: 'architect-design-v2' } },
      { catalog: { ...catalog, key: 'architect-design-v1' } },
      { catalog: { ...catalog, entrances: [...catalog.entrances, 'glass'] } },
      { catalog: { ...catalog, landscaping: catalog.landscaping.slice(1) } },
      { catalog: { ...catalog, default: { ...catalog.default, landscaping: 'garden' } } },
      { catalog: { ...catalog, default: { facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard' } } },
      { catalog: { key: catalog.key, facades: catalog.facades, roofs: catalog.roofs, windows: catalog.windows, lighting: catalog.lighting, default: catalog.default } },
      { designs: [{ ...design, ...v2, entrance: 'canopy', landscaping: 'garden' }] },
      { designs: [{ ...design, ...v3, entrance: null }] },
      { designs: [{ ...design, ...v3, landscaping: 'pond' }] },
      { designs: [{ ...design, ...v3, entrance: 'grand-portico' }] },
      { designs: [{ propertyId: id, buildingId: `b-${id}`, revision: 1, catalog: 'architect-design-v2', facade: 'brick', roof: 'spire', windows: 'ribbon', lighting: 'cool' }] },
      { catalog: { ...catalog, facades: [...catalog.facades, 'aurora'] } },
      { catalog: { ...catalog, roofs: catalog.roofs.slice(1) } },
      { catalog: { ...catalog, windows: [...catalog.windows, 'panoramic'] } },
      { catalog: { ...catalog, lighting: catalog.lighting.slice(1) } },
      { catalog: { ...catalog, default: { ...catalog.default, facade: 'jade' } } },
      { catalog: { ...catalog, default: { facade: 'slate', roof: 'flat' } } },
      { catalog: { key: catalog.key, facades: catalog.facades, roofs: catalog.roofs, default: { facade: 'slate', roof: 'flat' } } },
      { designs: [{ ...design, facade: 'aurora' }] },
      { designs: [{ ...design, facade: '<b>x</b>' }] },
      { designs: [{ ...design, windows: 'grid', lighting: 'standard' }] },
      { designs: [{ ...design, ...v2, windows: null }] },
      { designs: [{ ...design, ...v2, lighting: 'neon' }] },
      { designs: [{ ...design, ...v2, catalog: 'architect-design-v1' }] },
      { designs: [{ propertyId: id, buildingId: `b-${id}`, revision: 1, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome' }] },
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
    expect(parseRehearsalDesignView({ ...view, saved: { ...view.saved, windows: 'grid' } })).toBeNull()
    const both = { ...view, saved: { revision: 2, ...v2, atCitySequence: 5, at }, history: [{ revision: 2, ...v2, by: 'viewer', at }, view.history[0]], historyCount: 2 }
    expect(parseRehearsalDesignView(both)).toEqual(both)
    const all = { ...view, saved: { revision: 3, ...v3, atCitySequence: 6, at }, history: [{ revision: 3, ...v3, by: 'other', at }, ...both.history], historyCount: 3 }
    expect(parseRehearsalDesignView(all)).toEqual(all)
    expect(parseRehearsalDesignView({ ...all, history: [{ ...all.history[0], entrance: null }, ...both.history] })).toBeNull()
    expect(parseRehearsalDesignView({ ...all, saved: { ...all.saved, landscaping: '<svg>' } })).toBeNull()
    expect(parseRehearsalDesignView({ ...both, history: [{ ...both.history[0], lighting: '#fff' }, view.history[0]] })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, control: 'owner' })).toBeNull()
    expect(parseRehearsalDesignView({ ...view, saved: null, history: [], historyCount: 0 })).toMatchObject({ saved: null })
    const answer = { rehearsal: REHEARSAL_MARK, fresh: true, design: { ...design, actionId: '0190cccc-0000-4000-8000-0000000000aa', atCitySequence: 4, designedAt: '2026-10-24T00:00:00.000Z' }, view }
    expect(parseRehearsalDesignResponse(answer)).toEqual(answer)
    expect(parseRehearsalDesignResponse({ ...answer, view: null })).toMatchObject({ view: null })
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, roof: 'halo' } })).toBeNull()
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, ...v2 } })).toMatchObject({ design: v2 })
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, ...v2, windows: 'panoramic' } })).toBeNull()
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, ...v3 } })).toMatchObject({ design: v3 })
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, ...v3, landscaping: 'standard', entrance: 'canopy' } })).toMatchObject({ design: { entrance: 'canopy' } })
    expect(parseRehearsalDesignResponse({ ...answer, design: { ...answer.design, ...v3, entrance: 'awning' } })).toBeNull()
    const short: Record<string, unknown> = { ...answer.design }
    delete short.windows
    delete short.lighting
    expect(parseRehearsalDesignResponse({ ...answer, design: short })).toBeNull()
    const shorter: Record<string, unknown> = { ...answer.design, ...v2 }
    delete shorter.entrance
    delete shorter.landscaping
    expect(parseRehearsalDesignResponse({ ...answer, design: shorter })).toBeNull()
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
