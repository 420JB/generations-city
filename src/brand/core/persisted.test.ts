import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BuildingSprite } from '../../ui/city/BuildingSprite'
import { CitySceneContext } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, type WorldCityState } from '../../world/cityState'
import { proposePropertyActivation } from '../../world/gameplay'
import { loadPersistedBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { parseBrandCityConfig } from './config'
import { compileBrandWorld } from './layout'
import { persistedBrandCityState } from './persisted'

const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'

function config() {
  const parsed = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
  if (!parsed.ok) throw new Error('sample invalid')
  return parsed.config
}

describe('a persistent city as the renderer draws it', () => {
  it('is exactly what is stored: an empty city, every district on its founding ward, nothing held', () => {
    const state = persistedBrandCityState(config(), emptyWorldCityState())
    expect(state).toEqual({
      users: {},
      buildings: {},
      nfts: {},
      wards: Object.fromEntries(config().districts.map((d) => [d.key, 1])),
      monuments: expect.any(Object),
      capital: { holder: null, sinceClock: 0 },
      crown: { holder: null, sinceClock: 0 },
    })
    expect(Object.values(state.monuments).every((m) => m.holder === null)).toBe(true)
  })

  it('is drawn only on the geometry the city was founded on', () => {
    const c = config()
    const compiled = compileBrandWorld(c)
    if (!compiled.ok) throw new Error('world')
    const loaded = loadPersistedBrandCity(c, emptyWorldCityState(), compiled.world.layout.geometryFingerprint)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(Object.keys(loaded.city.state.buildings)).toEqual([])
    expect(loadPersistedBrandCity(c, emptyWorldCityState(), 'f'.repeat(64))).toEqual({ ok: false, problems: [{ path: 'districts', detail: 'this configuration does not draw the districts this city was founded on' }] })
  })
})

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

describe('a persistent city\'s token labels (L4)', () => {
  it('show every token id in its canonical decimal spelling, however large; small ones read as before', () => {
    const c = config()
    const compiled = compileBrandWorld(c)
    if (!compiled.ok) throw new Error('world')
    const collection = c.collections[0]
    let state: WorldCityState = emptyWorldCityState()
    const tokens = [MAX_UINT256, '9007199254740993', '812']
    tokens.forEach((tokenId, i) => {
      const next = proposePropertyActivation(compiled.world, state, i + 1, { asset: nftAsset({ chain: collection.chain, contract: collection.contract, tokenId })!, plotId: `${c.districts[0].key}-w0-p${i}` })
      if (!next.ok) throw new Error(next.reason)
      state = next.transition.state
    })
    const loaded = loadPersistedBrandCity(c, state, compiled.world.layout.geometryFingerprint)
    if (!loaded.ok) throw new Error('load')
    const { scene, state: drawn } = loaded.city
    const buildings = Object.values(drawn.buildings)
    // friendId is display-only and rounds above 2^53: exactly what the labels must not show.
    expect(buildings.map((b) => String(b.friendId))).not.toEqual(tokens)
    expect(buildings.map((b) => scene.buildingToken!(b))).toEqual(tokens)
    expect(buildings.map((b) => scene.buildingLabel(b))).toEqual(tokens.map((t) => `${collection.displayName} #${t}`))
    for (const [i, b] of buildings.entries()) {
      const html = renderToStaticMarkup(
        createElement(CitySceneContext.Provider, { value: scene }, createElement(BuildingSprite, { building: b, total: 0, users: {}, selected: false, isPlayer: false, isCrown: false, detail: 'near', fx: null, onSelect: () => {}, labelScale: 1, isObjective: false })),
      )
      expect(html).toContain(`#${tokens[i]} · T0`)
    }
  })
})
