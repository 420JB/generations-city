import { describe, expect, it } from 'vitest'
import { emptyWorldCityState } from '../../world/cityState'
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
