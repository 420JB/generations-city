import { describe, expect, it } from 'vitest'
import { DISTRICTS } from '../../config/districts'
import { WORLD } from '../../config/world'
import { cityRadius, civicScale, civicSlotWorld, districtAngle, plotWorld, wardCapacity } from '../../game/world'
import { STANDARD_RADIAL_PARAMS } from '../../brand/core/layout'
import { brandScene } from '../../brand/scene'
import { parseBrandCityConfig, type BrandCityConfig } from '../../brand/core/config'
import { compileBrandWorld } from '../../brand/core/layout'
import { districtOf } from '../../world/definition'
import { plotPointOf, wardCapacityOf } from '../../world/layout'
import { civicPadsFitIn, civicPadsIn, civicSlotIn, plotWorldIn, sceneCityRadius, sceneCivicScale, STANDARD_LAYOUT_PARAMS, wardCapacityIn } from './districtGeometry'
import { footprintHalf } from './geometry'
import { RARE_CITY_SCENE } from './legacyScene'
import { minClearance, propertyLotHalf } from './roads'
import { sceneDistrict } from './scene'

const WARDS = [0, 1, 2, 5, 19]

describe('the legacy scene is the Rare City layout, bit for bit', () => {
  it('has the nine family districts in order, at the legacy angles and colours', () => {
    expect(RARE_CITY_SCENE.districts.map((d) => d.id)).toEqual(DISTRICTS.map((d) => d.id))
    for (const d of DISTRICTS) {
      const s = sceneDistrict(RARE_CITY_SCENE, d.id)
      expect(s.centerDeg).toBe(districtAngle(d.id))
      expect(s.spanDeg).toBe(WORLD.districtSpanDeg)
      expect([s.color, s.glow, s.ground, s.title, s.familyKey, s.paint]).toEqual([d.color, d.glow, d.ground, d.title, d.familyKey, d.id])
      expect(s.crest).toBe(d.art.primaryTransparent)
    }
  })

  it('every plot, capacity, civic slot and radius equals the legacy engine exactly', () => {
    for (const d of DISTRICTS) {
      const s = sceneDistrict(RARE_CITY_SCENE, d.id)
      for (const w of WARDS) {
        expect(wardCapacityIn(s, w)).toBe(wardCapacity(w))
        for (let i = 0; i < wardCapacity(w); i++) expect(plotWorldIn(s, w, i)).toEqual(plotWorld(d.id, w, i))
      }
      for (let count = 1; count <= 5; count++) for (let i = 0; i < count; i++) expect(civicSlotIn(RARE_CITY_SCENE, s, i, count)).toEqual(civicSlotWorld(d.id, i, count))
    }
    for (let count = 1; count <= 5; count++) expect(sceneCivicScale(RARE_CITY_SCENE, count)).toBe(civicScale(count))
    const wards = Object.fromEntries(DISTRICTS.map((d, i) => [d.id, 1 + (i % 4)])) as Record<(typeof DISTRICTS)[number]['id'], number>
    expect(sceneCityRadius(RARE_CITY_SCENE, wards)).toBe(cityRadius(wards))
  })

  it('the renderer and brand cities use one standard layout', () => {
    expect(STANDARD_LAYOUT_PARAMS).toEqual(STANDARD_RADIAL_PARAMS)
  })
})

function evenBrand(n: number): BrandCityConfig {
  const parsed = parseBrandCityConfig({
    worldId: `b0000000-0000-4000-8000-00000000000${n}`,
    cityName: `City ${n}`,
    brand: { name: 'Brand', logo: null },
    capital: { name: 'Hall', crest: null },
    collections: [{ key: 'main', chain: 'eip155:8453', contract: `0x${'1'.repeat(40)}`, displayName: 'Main' }],
    districts: Array.from({ length: n }, (_, i) => ({ key: `district-${i + 1}`, name: `District ${i + 1}`, accent: '#336699', monument: null, gate: null })),
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  return parsed.config
}

describe('brand scenes draw exactly what the world engine means', () => {
  for (const n of [3, 4, 6, 9]) {
    it(`${n} districts: every drawn plot stands where the engine says, with the engine's capacities`, () => {
      const config = evenBrand(n)
      const compiled = compileBrandWorld(config)
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
      const world = compiled.world
      const scene = brandScene(config, world)
      expect(scene.districts).toHaveLength(n)
      for (const s of scene.districts) {
        const d = districtOf(world, s.id)!
        expect([s.centerDeg, s.spanDeg]).toEqual([d.centerDeg, d.spanDeg])
        for (const w of [0, 1, 3]) {
          expect(wardCapacityIn(s, w)).toBe(wardCapacityOf(world, d, w))
          for (let i = 0; i < wardCapacityIn(s, w); i++) expect(plotWorldIn(s, w, i)).toEqual(plotPointOf(world, d, w, i))
        }
      }
    })

    it(`${n} districts: every lot clears every road and the civic monuments fit`, () => {
      const config = evenBrand(n)
      const compiled = compileBrandWorld(config)
      if (!compiled.ok) throw new Error('compile')
      const scene = brandScene(config, compiled.world)
      for (const s of scene.districts.slice(0, 2))
        for (const w of [0, 1, 4])
          for (let i = 0; i < wardCapacityIn(s, w); i++) {
            const p = plotWorldIn(s, w, i)
            for (const tier of [0, 6]) {
              const lot = propertyLotHalf(s, w, i, tier)
              expect(lot).toBeGreaterThan(footprintHalf(tier))
              expect(minClearance(s, w, p, lot).px, `${s.id} w${w} p${i} T${tier}`).toBeGreaterThanOrEqual(2)
            }
          }
      for (let count = 1; count <= 5; count++) {
        const scale = sceneCivicScale(scene, count)
        // Monuments are never drawn larger than in Rare City.
        expect(scale).toBeGreaterThanOrEqual(civicScale(count))
        expect(scale).toBeLessThanOrEqual(1)
        for (const s of scene.districts) expect(civicPadsFitIn(s, civicPadsIn(s, count, scale))).toBe(true)
      }
    })
  }
})
