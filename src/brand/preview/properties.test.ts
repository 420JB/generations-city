import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CitySceneContext } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, worldBuildingId, type WorldCityState } from '../../world/cityState'
import { proposePropertyActivation } from '../../world/gameplay'
import { parseBrandCityConfig } from '../core/config'
import { compileBrandWorld } from '../core/layout'
import { districtPlots, loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { ConstructionNote, MyPropertiesPanel, PropertyContextCard, type PropertyHome } from './home'
import { BuildingPreviewPanel } from './panels'
import { foundedProperties, foundingOrder, ordinal, plotAddress, propertyContext } from './properties'
import type { StoredProperty } from './rehearsal'

const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'
const parsed = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
if (!parsed.ok) throw new Error('sample invalid')
const config = parsed.config
const compiled = compileBrandWorld(config)
if (!compiled.ok) throw new Error('world')
const world = compiled.world
const [keepers, pass] = config.collections

/** A stored city with four properties, activated in this order. */
const PLACED = [
  { collection: keepers, tokenId: '812', plotId: 'lantern-quay-w0-p0' },
  { collection: pass, tokenId: '77', plotId: 'tidewater-w0-p0' },
  { collection: keepers, tokenId: '300', plotId: 'lantern-quay-w0-p3' },
  { collection: keepers, tokenId: '400', plotId: 'lantern-quay-w0-p1' },
]
let state: WorldCityState = emptyWorldCityState()
for (const [i, p] of PLACED.entries()) {
  const next = proposePropertyActivation(world, state, i + 1, { asset: nftAsset({ chain: p.collection.chain, contract: p.collection.contract, tokenId: p.tokenId })!, plotId: p.plotId })
  if (!next.ok) throw new Error(next.reason)
  state = next.transition.state
}
const STATE = state
const ids = Object.values(STATE.buildings).map((b) => b.propertyId)
const [first, second, third, fourth] = ids
const loaded = loadPersistedBrandCity(config, STATE, world.layout.geometryFingerprint)
if (!loaded.ok) throw new Error('load')
const CITY: LoadedBrandCity = loaded.city

const html = (el: ReactElement) => renderToStaticMarkup(createElement(CitySceneContext.Provider, { value: CITY.scene }, el))
/** What a person reads: the markup without its tags and attributes. */
const text = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const OWNERSHIP = /\b(own|owns|owned|owner|owners|ownership|yours)\b/i

describe('the properties a player founded, as the stored city and the server\'s record say', () => {
  it('lists exactly the stored properties the record names, most recent first, each with its NFT, district and exact plot', () => {
    const founded = foundedProperties(STATE, [first, third])
    expect(founded.map((p) => p.propertyId)).toEqual([third, first])
    expect(founded[0]).toEqual({
      buildingId: worldBuildingId(third),
      propertyId: third,
      asset: `${keepers.chain}/erc721:${keepers.contract}/300`,
      collection: 'harbor-keepers',
      tokenId: '300',
      districtKey: 'lantern-quay',
      ward: 0,
      plot: 3,
      plotId: 'lantern-quay-w0-p3',
      sequence: 4,
      order: 3,
    })
    expect(founded[1]).toMatchObject({ tokenId: '812', plotId: 'lantern-quay-w0-p0', sequence: 2, order: 1 })
  })

  it('never invents a property: an id the city does not hold, or one named twice, adds nothing', () => {
    expect(foundedProperties(STATE, [first, '0199f1a2-0000-7000-8000-000000000000', first]).map((p) => p.propertyId)).toEqual([first])
    expect(foundedProperties(STATE, [])).toEqual([])
    expect(foundedProperties(emptyWorldCityState(), [first])).toEqual([])
  })

  it('is scoped by the record alone: the same city lists nothing for a player the record names for nothing', () => {
    // Another player's founding is never in this list, whoever the city shows standing next to it.
    expect(foundedProperties(STATE, [second]).map((p) => p.tokenId)).toEqual(['77'])
    expect(foundedProperties(STATE, [fourth]).map((p) => p.tokenId)).toEqual(['400'])
  })

  it('numbers the city\'s foundings by the sequence that activated them', () => {
    expect([...foundingOrder(STATE)]).toEqual([
      [first, 1],
      [second, 2],
      [third, 3],
      [fourth, 4],
    ])
  })
})

describe('the city and district around a property', () => {
  it('counts the stored city, lists the closest neighbours of its district first, and every other district', () => {
    const c = propertyContext(CITY, worldBuildingId(first))!
    expect(c.cityProperties).toBe(4)
    expect(c.district).toEqual({ key: 'lantern-quay', properties: 3, wardsOpen: 1, freePlots: districtPlots(CITY, 'lantern-quay').length })
    expect(c.neighbours.map((n) => n.tokenId)).toEqual(['400', '300'])
    expect(c.neighbours[0]).toEqual({ buildingId: worldBuildingId(fourth), collection: 'harbor-keepers', tokenId: '400', ward: 0, plot: 1 })
    expect(c.moreNeighbours).toBe(0)
    expect(c.others).toEqual([
      { key: 'tidewater', properties: 1 },
      { key: 'saltmarsh', properties: 0 },
      { key: 'compass-row', properties: 0 },
    ])
  })

  it('caps the neighbours and says how many more there are; a lone property has none', () => {
    const c = propertyContext(CITY, worldBuildingId(first), 1)!
    expect(c.neighbours.map((n) => n.tokenId)).toEqual(['400'])
    expect(c.moreNeighbours).toBe(1)
    expect(propertyContext(CITY, worldBuildingId(second))!.neighbours).toEqual([])
    expect(propertyContext(CITY, 'b-nothing')).toBeNull()
  })

  it('says addresses and places as the city does', () => {
    expect(plotAddress(0, 2)).toBe('Ward I · Plot 3')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th', '112th'])
  })
})

describe('MY PROPERTIES', () => {
  const home = (originalActivations: string[], unrecorded = 0): PropertyHome => ({ founded: foundedProperties(STATE, originalActivations), unrecorded })
  const panel = (h: PropertyHome, claim: { label: string; run: () => void } | null = null) => html(createElement(MyPropertiesPanel, { city: CITY, home: h, claim, onView: () => {}, onClose: () => {} }))

  it('says plainly when the player has founded nothing here, and offers the claim only when there is one', () => {
    const empty = panel(home([]))
    expect(empty).toContain('data-testid="my-properties-empty"')
    expect(empty).toContain('data-count="0"')
    expect(text(empty)).toContain('You have not founded a property in Harborlight yet.')
    expect(empty).not.toContain('my-properties-claim')
    expect(panel(home([]), { label: 'Claim an NFT', run: () => {} })).toMatch(/data-testid="my-properties-claim"[^>]*>Claim an NFT</)
  })

  it('lists each founded property with its NFT, district, exact plot and a labelled way to warp there', () => {
    const list = panel(home([first, third]))
    expect(list).toContain('data-count="2"')
    expect(text(list)).toContain('Founded by you · 2')
    expect(list.match(/data-testid="my-property"/g)).toHaveLength(2)
    // Most recent first.
    expect(list.indexOf('data-plot-id="lantern-quay-w0-p3"')).toBeLessThan(list.indexOf('data-plot-id="lantern-quay-w0-p0"'))
    expect(text(list)).toContain('Harbor Keepers #300')
    expect(text(list)).toContain('Lantern Quay District · Ward I · Plot 4 · Founding Ward')
    expect(text(list)).toContain('Tier 0 · 3rd property of the city')
    expect(list).toContain('aria-label="Warp to Harbor Keepers #812, Lantern Quay District, Ward I · Plot 1"')
    expect(list).toContain('aria-label="Properties you founded in Harborlight"')
  })

  it('calls a founding a founding: nothing claims who holds the NFT now', () => {
    const list = panel(home([first, third], 2))
    expect(text(list)).not.toMatch(OWNERSHIP)
    expect(text(list)).toContain('A founding is permanent; it does not say who holds the NFT today.')
    expect(text(list)).toContain('Current NFT holders are not checked here.')
    expect(text(list)).toContain('2 properties here were placed before founders were recorded, so no one’s list shows them.')
  })
})

describe('a stored property\'s panel', () => {
  const stored = (activator: StoredProperty['activator']): StoredProperty => ({ ...STATE.buildings[worldBuildingId(first)], activator, order: 1 })
  const panel = (s: StoredProperty | null, extra: object = {}) =>
    html(createElement(BuildingPreviewPanel, { city: CITY, buildingId: worldBuildingId(first), member: null, stored: s, onDistrict: () => {}, onClose: () => {}, onBuild: () => {}, ...extra }))

  it('keeps the founder apart from the NFT\'s current holder, which it never claims to know', () => {
    const mine = panel(stored('viewer'))
    expect(mine).toMatch(/data-testid="property-founder" data-activator="viewer">You</)
    expect(mine).toMatch(/data-testid="property-holder"[^>]*>Not verified</)
    expect(text(mine)).toContain('The 1st property founded in Harborlight.')
    expect(text(mine)).not.toMatch(OWNERSHIP)
    expect(panel(stored('other'))).toMatch(/data-activator="other">Recorded privately</)
    expect(panel(stored('unrecorded'))).toMatch(/data-activator="unrecorded">Not recorded</)
  })

  it('offers no build, spend or progress: construction is said to come later, once', () => {
    const mine = panel(stored('viewer'))
    expect(mine).not.toContain('build-action')
    expect(mine).not.toContain('role="progressbar"')
    expect(mine).not.toMatch(/<button[^>]*>[^<]*(Build|Upgrade|Spend)/)
    expect(mine.match(/data-testid="construction-note"/g)).toHaveLength(1)
    expect(text(mine)).toContain('This property is a Tier 0 foundation, as every new property starts. Building upward is not open in this city yet')
    expect(html(createElement(ConstructionNote, { tier: 0 }))).toContain('data-tier="0"')
  })

  it('returns to the player\'s properties only when given a way back, and shows the city around it', () => {
    expect(panel(stored('viewer'))).not.toContain('aria-label="Back"')
    const context = createElement(PropertyContextCard, { city: CITY, context: propertyContext(CITY, worldBuildingId(first))!, onWarp: () => {}, onDistrict: () => {} })
    const full = panel(stored('viewer'), { onBack: () => {}, context })
    expect(full).toContain('aria-label="Back"')
    expect(full).toMatch(/data-testid="property-context"[^>]*data-district-properties="3" data-city-properties="4"/)
    expect(full.match(/data-testid="property-neighbour"/g)).toHaveLength(2)
    expect(full).toContain('aria-label="Warp to Harbor Keepers #400, Ward I · Plot 2"')
    expect(full).toMatch(/data-testid="explore-tidewater" data-properties="1"/)
    expect(text(full)).not.toMatch(OWNERSHIP)
  })

  it('is unchanged for a simulated sample building: the preview build and its progress stay', () => {
    const sample = panel(null)
    expect(sample).toContain('data-testid="build-action"')
    expect(sample).toContain('role="progressbar"')
    expect(sample).not.toContain('construction-note')
    expect(sample).not.toContain('property-founder')
  })
})
