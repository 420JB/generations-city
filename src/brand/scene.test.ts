import { describe, expect, it } from 'vitest'
import { MONUMENTS } from '../config/monuments'
import { sceneDistrict } from '../ui/city/scene'
import { loadBrandCity } from './load'
import { HARBORLIGHT, NEON_ORCHARD, SAMPLE_BRANDS } from './samples'
import { mixHex, monogramOf } from './scene'

const load = (b: (typeof SAMPLE_BRANDS)[number]) => {
  const r = loadBrandCity(b.config, b.city)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.city
}

describe('brand scene', () => {
  it('has exactly the configured districts, named and coloured by the brand, placed by the engine', () => {
    const { scene, config, world } = load(NEON_ORCHARD)
    expect(scene.districts.map((d) => d.id)).toEqual(config.districts.map((d) => d.key))
    scene.districts.forEach((d, i) => {
      expect(d.name).toBe(config.districts[i].name)
      expect(d.color).toBe(config.districts[i].accent)
      expect(d.centerDeg).toBe(world.districts[i].centerDeg)
      expect(d.familyKey).toBeNull()
      expect(d.paint).toBe(`bd-${d.id}`)
    })
    expect(new Set(scene.districts.map((d) => d.paint)).size).toBe(6)
  })

  it('keeps the standard monuments and only renames the Friend Statue', () => {
    const { scene } = load(HARBORLIGHT)
    expect(scene.monuments.map((m) => [m.id, m.tier, m.kind])).toEqual(MONUMENTS.map((m) => [m.id, m.tier, m.kind]))
    expect(scene.monuments.find((m) => m.kind === 'statue')!.name).toBe('The District Monument')
    expect(JSON.stringify(scene.monuments)).not.toMatch(/Friend/)
  })

  it('District Monument: configured artwork, else the standard emblem', () => {
    const a = load(HARBORLIGHT).scene
    expect(a.statueFor('lantern-quay')).toEqual({ kind: 'portrait', name: 'Lantern Quay', image: '/brand-media/samples/harbor-keeper-1004.svg', caption: 'Harbor Keepers #1004' })
    expect(a.statueFor('saltmarsh')).toEqual({ kind: 'emblem', name: 'Saltmarsh', monogram: 'S' })
    const b = load(NEON_ORCHARD).scene
    expect(b.statueFor('kiwi-docks').kind).toBe('emblem')
  })

  it('names buildings by their NFT, and crests are the brand logo or a one-character monogram', () => {
    const { scene, state } = load(HARBORLIGHT)
    const crown = state.buildings[state.crown.holder!]
    expect(scene.buildingLabel(crown)).toBe('Harbor Keepers #1000')
    expect(sceneDistrict(scene, 'tidewater').crest).toBe('/brand-media/samples/harborlight-logo.svg')
    expect(scene.capital).toMatchObject({ name: 'Beacon Hall', crest: '/brand-media/samples/harborlight-logo.svg' })
    expect(monogramOf('<script>')).toBe('S')
    expect(monogramOf('  ')).toBe('★')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('a brand without a logo gets a generated monogram crest that carries no configuration text', () => {
    const cfg = JSON.parse(JSON.stringify(HARBORLIGHT.config))
    cfg.brand = { name: '<img src=x onerror=alert(1)>', logo: null }
    cfg.capital = { name: 'Hall', crest: null }
    const r = loadBrandCity(cfg, HARBORLIGHT.city)
    if (!r.ok) throw new Error('load')
    const crest = sceneDistrict(r.city.scene, 'tidewater').crest
    expect(crest.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(crest)).not.toMatch(/onerror|<img/)
    expect(r.city.scene.capital.crest).toBeUndefined()
  })
})

describe('sample isolation', () => {
  it('only the preview entry point imports the simulated samples', () => {
    const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const importers = Object.entries(sources)
      // A type-only import is erased from the bundle, so it carries no sample data.
      .filter(([, text]) => /^import (?!type )[^\n]*from '(\.\.\/|\.\/)+(brand\/)?samples'/m.test(text))
      .map(([path]) => path)
    expect(importers).toEqual(['/src/brand/preview/main.tsx'])
  })
})
