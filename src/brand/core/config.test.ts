import { describe, expect, it } from 'vitest'
import { HARBORLIGHT, NEON_ORCHARD } from '../samples'
import { BRAND_LIMITS, parseBrandCityConfig } from './config'
import { safeMediaHref, vetMediaRef } from './media'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
type Raw = { districts: Record<string, unknown>[]; collections: Record<string, unknown>[]; brand: Record<string, unknown>; [k: string]: unknown }
const raw = () => clone(HARBORLIGHT.config) as Raw
const problemsOf = (input: unknown) => {
  const r = parseBrandCityConfig(input)
  return r.ok ? [] : r.problems.map((p) => p.path)
}

describe('brand configuration', () => {
  it('accepts both sample brands and freezes the result', () => {
    for (const s of [HARBORLIGHT, NEON_ORCHARD]) {
      const r = parseBrandCityConfig(s.config)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(Object.isFrozen(r.config.districts[0])).toBe(true)
        expect(Object.isFrozen(r.config.collections)).toBe(true)
      }
    }
  })

  it('reads its input once: later changes to the caller\'s object do not reach the result', () => {
    const input = raw()
    const r = parseBrandCityConfig(input)
    input.districts[0].name = 'Changed'
    expect(r.ok && r.config.districts[0].name).toBe('Lantern Quay')
  })

  it(`allows ${BRAND_LIMITS.minDistricts} to ${BRAND_LIMITS.maxDistricts} districts and nothing else`, () => {
    const base = raw()
    const d = (i: number) => ({ key: `d-${i}`, name: `D ${i}`, accent: '#123456', monument: null, gate: null })
    for (const n of [0, 1, 2, 10]) expect(problemsOf({ ...base, districts: Array.from({ length: n }, (_, i) => d(i)) })).toContain('districts')
    for (const n of [3, 9]) expect(problemsOf({ ...base, districts: Array.from({ length: n }, (_, i) => d(i)) })).toEqual([])
  })

  it('refuses duplicate keys, bad accents, unsafe names and unknown monument collections', () => {
    const c = raw()
    c.districts[1].key = c.districts[0].key
    c.districts[2].accent = 'red'
    c.districts[3].name = 'Evil‮Name'
    c.districts[0].monument = { collection: 'nope', tokenId: '1', artwork: null }
    const p = problemsOf(c)
    expect(p).toEqual(expect.arrayContaining(['districts[1].key', 'districts[2].accent', 'districts[3].name', 'districts[0].monument.collection']))
  })

  it('accepts only canonical decimal token ids and positive-integer Proofy verification rule ids', () => {
    for (const tokenId of ['01', '1e3', '-1', '0x10', 1004, ' 1']) {
      const c = raw()
      ;(c.districts[0].monument as Record<string, unknown>).tokenId = tokenId
      expect(problemsOf(c), String(tokenId)).toContain('districts[0].monument.tokenId')
    }
    for (const id of ['9001', 0, -1, 1.5, null, 2 ** 60]) {
      const c = raw()
      ;(c.districts[3].gate as Record<string, unknown>).verificationRuleId = id
      expect(problemsOf(c), String(id)).toContain('districts[3].gate.verificationRuleId')
    }
    const c = raw()
    ;(c.districts[3].gate as Record<string, unknown>).source = 'admin'
    expect(problemsOf(c)).toContain('districts[3].gate.source')
  })

  it('refuses any artwork, logo or crest that is not a vetted local reference', () => {
    const bad = [
      'https://cdn.example.com/a.png',
      'http://example.com/a.png',
      '//evil.example/a.png',
      'javascript:alert(1)',
      'ipfs://Qm123/a.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PGgxPg==',
      '/brand-media/../secrets.png',
      '/brand-media/a.png?track=1',
      '/brand-media/a.png#x',
      '/other/a.png',
      '/brand-media/a.gif',
      '/brand-media//a.png',
      'blob:https://x/1',
    ]
    for (const ref of bad) {
      expect(vetMediaRef(ref).ok, ref).toBe(false)
      const c = raw()
      ;(c.districts[0].monument as Record<string, unknown>).artwork = ref
      c.brand.logo = ref
      expect(problemsOf(c), ref).toEqual(expect.arrayContaining(['districts[0].monument.artwork', 'brand.logo']))
    }
    expect(safeMediaHref('/brand-media/samples/harbor-keeper-1004.svg')).toBe('/brand-media/samples/harbor-keeper-1004.svg')
    expect(safeMediaHref('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(vetMediaRef(`data:image/png;base64,${'A'.repeat(300_000)}`)).toEqual({ ok: false, problem: 'too-large' })
  })

  it('carries no economy, layout or gameplay fields: unknown fields are dropped', () => {
    const c = { ...raw(), economy: { price: 1 }, layout: { spanDeg: 10 }, tiers: [1] }
    const r = parseBrandCityConfig(c)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.config).sort()).toEqual(['brand', 'capital', 'cityName', 'collections', 'districts', 'worldId'])
  })
})
