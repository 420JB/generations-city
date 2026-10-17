import { describe, expect, it } from 'vitest'
import { HARBORLIGHT } from '../samples'
import { buildSampleCity } from './sampleCity'
import { parseBrandCityConfig } from './config'
import { compileBrandWorld } from './layout'
import { MAX_VERIFICATION_RULE_ID, parsePlayCityConfig, PLAY_CONFIG_JSON_SCHEMA, playPreviewWorldId } from './playConfig'
import { standardSimulation } from './simulation'

const WORLD = '65f52587-14b5-8a6e-aae7-faf8ea5651ec'

/** The Harborlight sample, rewritten as an admin would enter it in Proofy Play (schema v1). */
function harborlightDocument() {
  const c = structuredClone(HARBORLIGHT.config) as { worldId?: string; districts: Record<string, unknown>[] } & Record<string, unknown>
  delete c.worldId
  c.districts = c.districts.map(({ gate, ...d }) => ({ ...d, proofyRule: gate ? { verificationRuleId: (gate as { verificationRuleId: number }).verificationRuleId, label: (gate as { label: string }).label } : null }))
  return c
}

const problemsOf = (doc: unknown) => {
  const r = parsePlayCityConfig(doc, WORLD)
  return r.ok ? [] : r.problems
}

describe('Rare City Play configuration (schema v1)', () => {
  it('reads a Play document into the same brand configuration the sample preview validates', () => {
    const r = parsePlayCityConfig(harborlightDocument(), WORLD)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sample = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
    if (!sample.ok) throw new Error('sample invalid')
    // Identical except that a Play rule reference always names a Proofy Core rule.
    const asCore = { ...sample.config, districts: sample.config.districts.map((d) => ({ ...d, gate: d.gate ? { ...d.gate, source: 'proofy-core' } : null })) }
    expect(r.config).toEqual(asCore)
    expect(r.config.districts[3].gate).toEqual({ source: 'proofy-core', verificationRuleId: 9001, label: 'Verified Captain role' })
  })

  it('a four-district Play city gets exactly the Harborlight sample\'s simulated skyline', () => {
    const r = parsePlayCityConfig(harborlightDocument(), WORLD)
    if (!r.ok) throw new Error('invalid')
    const world = compileBrandWorld(r.config)
    if (!world.ok) throw new Error('world')
    const sample = buildSampleCity(r.config, world.world, HARBORLIGHT.city)
    const standard = buildSampleCity(r.config, world.world, standardSimulation(r.config))
    // Only the member handles differ (names, not who owns what).
    const strip = (s: typeof sample) => ({ ...s, users: Object.values(s.users).map((u) => ({ ...u, handle: '' })) })
    expect(strip(standard)).toEqual(strip(sample))
  })

  it('closes every object: anything but the brand surface is refused', () => {
    const doc = harborlightDocument()
    expect(problemsOf({ ...doc, camera: { zoom: 3 } })).toContainEqual({ path: 'camera', detail: 'is not a configurable field' })
    expect(problemsOf({ ...doc, worldId: WORLD })).toContainEqual({ path: 'worldId', detail: 'is not a configurable field' })
    expect(problemsOf({ ...doc, brand: { ...doc.brand as object, font: 'Comic' } })).toContainEqual({ path: 'brand.font', detail: 'is not a configurable field' })
    const d = doc.districts
    expect(problemsOf({ ...doc, districts: [{ ...d[0], buildingStyle: 'pagoda' }, ...d.slice(1)] })).toContainEqual({ path: 'districts[0].buildingStyle', detail: 'is not a configurable field' })
    expect(problemsOf({ ...doc, districts: [{ ...d[0], monument: { ...(d[0].monument as object), scale: 9 } }, ...d.slice(1)] })).toContainEqual({ path: 'districts[0].monument.scale', detail: 'is not a configurable field' })
    const noRule = { ...d[1] }
    delete noRule.proofyRule
    expect(problemsOf({ ...doc, districts: [d[0], noRule, ...d.slice(2)] })).toContainEqual({ path: 'districts[1].proofyRule', detail: 'is required (use null for none)' })
    expect(problemsOf([doc])).toEqual([{ path: '', detail: 'must be an object' }])
  })

  it('takes media only from Rare City\'s /brand-media/ set', () => {
    const doc = harborlightDocument()
    for (const logo of ['https://cdn.example/logo.png', '//cdn.example/x.png', 'data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)']) {
      expect(problemsOf({ ...doc, brand: { name: 'X', logo } }).map((p) => p.path), logo).toContain('brand.logo')
    }
    expect(problemsOf({ ...doc, brand: { name: 'X', logo: '/brand-media/a/../b.svg' } }).map((p) => p.path)).toContain('brand.logo')
  })

  describe('the registered media pattern and the launch-time validator agree', () => {
    const schema = PLAY_CONFIG_JSON_SCHEMA.$defs.media
    const pattern = new RegExp(schema.pattern, 'u')
    const bySchema = (m: string) => m.length <= schema.maxLength && pattern.test(m)
    const byReader = (m: string) => !problemsOf({ ...harborlightDocument(), brand: { name: 'X', logo: m } }).some((p) => p.path === 'brand.logo')

    const valid = [
      '/brand-media/logo.png',
      '/brand-media/samples/harborlight-logo.svg',
      '/brand-media/a/b/c/d.webp',
      '/brand-media/A_1-b.2.jpeg',
      '/brand-media/x.jpg',
      '/brand-media/a.b.c.png',
      '/brand-media/a./b.png',
      '/brand-media/a-.png',
      '/brand-media/9/x_.svg',
      `/brand-media/${'a'.repeat(200 - '/brand-media/.png'.length)}.png`,
    ]
    const invalid = [
      // traversal
      '/brand-media/../x.png',
      '/brand-media/a/../../x.png',
      '/brand-media/a/../b.svg',
      '/brand-media/a/..',
      '/brand-media/a..b.png',
      '/brand-media/a/b..png',
      '/brand-media/a../b.png',
      '/brand-media/./x.png',
      // repeated or misplaced separators
      '/brand-media//x.png',
      '/brand-media/a//b.png',
      '/brand-media/a/.png',
      '/brand-media/a/',
      '/brand-media/',
      '/brand-media/a\\b.png',
      '/brand-media/a\\..\\b.png',
      // encoded traversal and other escapes
      '/brand-media/%2e%2e/x.png',
      '/brand-media/a%2fb.png',
      '/brand-media/%2E%2E%2Fx.png',
      '/brand-media/a.png%00.svg',
      // file types
      '/brand-media/a.html',
      '/brand-media/a.svgz',
      '/brand-media/a.PNG',
      '/brand-media/a.gif',
      '/brand-media/a.png.exe',
      '/brand-media/png',
      '/brand-media/.png',
      // hidden segments, query, fragment, whitespace, unicode
      '/brand-media/.hidden.png',
      '/brand-media/9/_x.svg',
      '/brand-media/-x.png',
      '/brand-media/a/.git/x.png',
      '/brand-media/a.png?x=1',
      '/brand-media/a.png#x',
      '/brand-media/a b.png',
      '/brand-media/a.png\n',
      '/brand-media/é.png',
      '/brand-media/a․b.png',
      // other prefixes and schemes
      '/brand-mediax/a.png',
      '/BRAND-MEDIA/a.png',
      'brand-media/a.png',
      '/other/a.png',
      'https://cdn.example/brand-media/a.png',
      '//cdn.example/brand-media/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      // length
      `/brand-media/${'a'.repeat(201 - '/brand-media/.png'.length)}.png`,
    ]

    it('both accept valid nested /brand-media/ paths', () => {
      for (const m of valid) expect([bySchema(m), byReader(m)], m).toEqual([true, true])
    })

    it('both refuse traversal, repeated separators, encodings, other file types and edge cases', () => {
      for (const m of invalid) expect([bySchema(m), byReader(m)], JSON.stringify(m)).toEqual([false, false])
    })

    it('agree on every short string over the path alphabet', () => {
      // Exhaustive up to 4 characters after the prefix, then the extension: covers every placement of `.`, `/`, `..` and `//`.
      const alphabet = ['a', '1', '_', '-', '.', '/', '%']
      const disagree: string[] = []
      let checked = 0
      const visit = (body: string) => {
        for (const ext of ['.png', '.svg', '', 'png']) {
          const m = `/brand-media/${body}${ext}`
          checked++
          if (bySchema(m) !== byReader(m)) disagree.push(m)
        }
        if (body.length < 4) for (const c of alphabet) visit(body + c)
      }
      visit('')
      expect(disagree).toEqual([])
      expect(checked).toBeGreaterThan(10_000)
    })

    it('is a pattern Play can run: no lookaround or backreferences', () => {
      expect(schema.pattern).not.toMatch(/\(\?[=!<]|\\k|\\[1-9]/)
    })
  })

  it('takes rule references that can be Proofy Core verification rule ids', () => {
    const doc = harborlightDocument()
    const withRule = (verificationRuleId: unknown) => ({ ...doc, districts: doc.districts.map((d, i) => (i === 0 ? { ...d, proofyRule: { verificationRuleId, label: 'Role' } } : d)) })
    expect(problemsOf(withRule(1))).toEqual([])
    expect(problemsOf(withRule(MAX_VERIFICATION_RULE_ID))).toEqual([])
    for (const id of [0, -1, 1.5, '7', MAX_VERIFICATION_RULE_ID + 1]) expect(problemsOf(withRule(id)).length, String(id)).toBeGreaterThan(0)
  })

  it('the registered JSON Schema closes the same objects and requires the same fields as the reader', () => {
    const s = PLAY_CONFIG_JSON_SCHEMA
    const closed = (o: { additionalProperties: boolean; required: readonly string[]; properties: object }) => ({ additional: o.additionalProperties, required: [...o.required].sort(), properties: Object.keys(o.properties).sort() })
    expect(closed(s)).toEqual({ additional: false, required: ['brand', 'capital', 'cityName', 'collections', 'districts'], properties: ['brand', 'capital', 'cityName', 'collections', 'districts'] })
    expect(closed(s.properties.brand).required).toEqual(['logo', 'name'])
    expect(closed(s.properties.capital).required).toEqual(['crest', 'name'])
    expect(closed(s.properties.collections.items).required).toEqual(['chain', 'contract', 'displayName', 'key'])
    expect(closed(s.properties.districts.items).required).toEqual(['accent', 'key', 'monument', 'name', 'proofyRule'])
    expect(closed(s.properties.districts.items.properties.monument.oneOf[1]).required).toEqual(['artwork', 'collection', 'tokenId'])
    expect(closed(s.properties.districts.items.properties.proofyRule.oneOf[1]).required).toEqual(['label', 'verificationRuleId'])
    expect(s.properties.districts.minItems).toBe(3)
    expect(s.properties.districts.maxItems).toBe(9)
    // Within Play's 64 KiB schema limit by a wide margin.
    expect(JSON.stringify(s).length).toBeLessThan(8_000)
  })
})

describe('preview world ids', () => {
  it('are stable, per installation and environment, and UUIDv8 (never a provisioned UUIDv7 world)', () => {
    const a = playPreviewWorldId('dev', '01a14806-e132-74c6-ae8d-d7ee9453ea64')
    expect(a).toBe(playPreviewWorldId('dev', '01a14806-e132-74c6-ae8d-d7ee9453ea64'))
    expect(a).not.toBe(playPreviewWorldId('dev', '01a14806-e132-74c6-ae8d-d7ee9453ea65'))
    expect(a).not.toBe(playPreviewWorldId('staging', '01a14806-e132-74c6-ae8d-d7ee9453ea64'))
    expect(a[14]).toBe('8')
  })
})
