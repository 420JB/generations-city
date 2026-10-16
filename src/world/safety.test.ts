import { describe, expect, it } from 'vitest'
import { nftAsset, type NftAsset } from './asset'
import { compileWorld, compileWorldOrThrow, districtOf, isWorld, WORLD_LIMITS, type World, type WorldDefinition } from './definition'
import { MAX_UINT256 } from './identity'
import { canOpenWard, wardCapacityOf } from './layout'
import { availablePlotsIn, choosePlot, formatPlotId, occupancyProblems, parsePlotId, resolvePlot, type WorldOccupancy } from './plots'
import { legacyPropertyIdPreimage, propertyIdV2Preimage, propertyIdVersionOf, worldProperty, worldPropertyIdPreimage } from './property'
import { RARE_CITY_WORLD, RARE_CITY_WORLD_DEFINITION, rareFriendAsset } from './rareCity'

/**
 * Hardening of the generic engine: V2 property identity, the legacy reservation, immutability,
 * resource limits, occupancy validation and geometry fingerprints. Worlds here are invented
 * for the test; none is a product decision.
 */
const BRAND_A = '01890a5d-ac96-774b-bcce-b302099a8057'
const BRAND_B = '01890a5d-ac96-774b-bcce-b302099a8058'
const ALPHA = '0x' + 'a1'.repeat(20)
const BETA = '0x' + 'b2'.repeat(20)
const RF = '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d'
const PARAMS = { coreWardInner: 22, coreWardOuter: 64, firstPlotRadius: 40, wardDepth: 24, rowOffsets: [3, 8.5, 15.5, 21], plotSpacing: 5.2, marginDeg: 3 }

function definition(o: { keys?: string[]; params?: Partial<typeof PARAMS>; maxWards?: number | null; worldId?: string } = {}): WorldDefinition {
  const keys = o.keys ?? ['north', 'harbor-front', 'old-town', 'z9']
  const span = 360 / keys.length
  return {
    worldId: o.worldId ?? BRAND_A,
    districts: keys.map((key) => ({ key })),
    collections: [{ key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }],
    layout: { kind: 'radial-wedge', key: 'test-ring', params: { ...PARAMS, ...o.params }, districts: keys.map((key, i) => ({ district: key, centerDeg: i * span - 180, spanDeg: span })), maxWards: o.maxWards === undefined ? null : o.maxWards },
    buildingIds: 'property-v1',
  }
}
const codes = (def: unknown) => {
  const c = compileWorld(def)
  return c.ok ? [] : c.problems.map((p) => p.code)
}
const details = (def: unknown) => {
  const c = compileWorld(def)
  return c.ok ? [] : c.problems.map((p) => p.detail)
}
/** A JSON value, as `JSON.parse` returns it. */
type Json = ReturnType<typeof JSON.parse>
const clone = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const asset = (contract: string, tokenId: string, chain = 'eip155:8453') => nftAsset({ chain, contract, tokenId })!

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('V2 property identity', () => {
  // GOLDEN VECTORS. Computed with node:crypto from the documented preimage, independently of
  // this code (server/tests/worldEngine.unit.test.ts recomputes them the same way).
  const MAX = MAX_UINT256.toString()
  const GOLDEN: [string, string, NftAsset, string][] = [
    ['base', BRAND_A, asset(ALPHA, '812'), 'cc965359-c42b-8708-8d24-70c89a5d34fe'],
    ['another collection', BRAND_A, asset(BETA, '812'), '26b3fdd4-5922-8e34-9f3c-f9770cc58434'],
    ['another chain', BRAND_A, asset(ALPHA, '812', 'eip155:1'), '25dc3ae0-5d33-85fe-a2bc-98f36c85b357'],
    ['another world', BRAND_B, asset(ALPHA, '812'), 'edae4f37-f364-8fbc-86e6-e954bf2bb930'],
    ['largest token', BRAND_A, asset(ALPHA, MAX), '69b2bc87-24d4-885a-80d8-61c144f30d56'],
    ['token 0', BRAND_A, asset(ALPHA, '0'), 'a430030d-5831-89bc-9b37-8e533037ae3c'],
    ['a Rare Friend in a brand world', BRAND_A, asset(RF, '812', 'eip155:4663'), 'a2ddd362-eb6f-82f5-9dde-21aea0cee269'],
  ]

  it.each(GOLDEN)('GOLDEN: %s', (_, worldId, nft, expected) => {
    const world = compileWorldOrThrow({ ...definition({ worldId }), collections: [{ key: 'c', chain: nft.chain, contract: nft.contract, standard: 'erc721' }] })
    const property = worldProperty(world, nft)!
    expect(property.propertyId).toBe(expected)
    expect(property.propertyIdVersion).toBe('v2')
    expect(property.buildingId).toBe(`b-${expected}`)
  })

  it('GOLDEN: the preimage text', () => {
    expect(propertyIdV2Preimage(BRAND_A, asset(ALPHA, '812'))).toBe(`proofy-world:property:v2|world=${BRAND_A}|asset=eip155:8453/erc721:${ALPHA}/812`)
    expect(propertyIdV2Preimage(BRAND_A, asset(ALPHA, MAX))).toBe(`proofy-world:property:v2|world=${BRAND_A}|asset=eip155:8453/erc721:${ALPHA}/${MAX}`)
  })

  it('every vector is distinct, and a Rare Friend in a brand world is not its legacy property', () => {
    expect(new Set(GOLDEN.map((g) => g[3])).size).toBe(GOLDEN.length)
    expect(GOLDEN.map((g) => g[3])).not.toContain('29d2ac0a-1754-8500-acdd-802ba2c51575')
  })

  it('depends on nothing configuration can change: keys, order, other collections, districts, layout, limits', () => {
    const nft = asset(ALPHA, '812')
    const variants: unknown[] = [
      definition(),
      { ...definition(), collections: [{ key: 'renamed', chain: 'eip155:8453', contract: ALPHA.toUpperCase().replace('0X', '0x'), standard: 'erc721' }] },
      { ...definition(), collections: [{ key: 'beta', chain: 'eip155:8453', contract: BETA, standard: 'erc721' }, { key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }] },
      definition({ keys: ['solo'] }),
      definition({ keys: Array.from({ length: 12 }, (_, i) => `k${i}`), params: { plotSpacing: 7 }, maxWards: 3 }),
    ]
    for (const v of variants) expect(worldProperty(compileWorldOrThrow(v), nft)!.propertyId).toBe('cc965359-c42b-8708-8d24-70c89a5d34fe')
    // A trial becoming a paid plan keeps its world, and the id needs nothing else.
    expect(propertyIdV2Preimage(BRAND_A, nft)).toBe(worldPropertyIdPreimage(BRAND_A, nft))
  })

  it('V2 is for brand worlds only, and V1 is for Rare Friends in the legacy world only', () => {
    expect(propertyIdVersionOf(BRAND_A)).toBe('v2')
    expect(propertyIdVersionOf('rare-city')).toBe('v1')
    expect(() => propertyIdVersionOf('brand-a')).toThrow()
    expect(() => propertyIdV2Preimage('rare-city', asset(ALPHA, '1'))).toThrow()
    expect(() => legacyPropertyIdPreimage(asset(ALPHA, '1'))).toThrow()
    expect(() => legacyPropertyIdPreimage(asset(RF, '1', 'eip155:1'))).toThrow()
    expect(legacyPropertyIdPreimage(rareFriendAsset('812')!)).toBe('rare-city:property:v1|world=rare-city|chain=4663|collection=0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d|token=812')
    expect(worldProperty(RARE_CITY_WORLD, rareFriendAsset('812')!)).toMatchObject({ propertyId: '29d2ac0a-1754-8500-acdd-802ba2c51575', propertyIdVersion: 'v1', buildingId: 'b-812' })
  })

  it('refuses a non-canonical asset rather than repair it', () => {
    const nft = asset(ALPHA, '812')
    for (const forged of [{ ...nft, tokenId: '0812' }, { ...nft, contract: ('0x' + 'A1'.repeat(20)) as `0x${string}` }, { ...nft, chain: 'eip155:08453' }, { ...nft, standard: 'erc1155' as never }])
      expect(() => propertyIdV2Preimage(BRAND_A, forged), JSON.stringify(forged)).toThrow()
  })
})

describe('the legacy identity is reserved', () => {
  it('the legacy definition compiles, also with its contract in lowercase', () => {
    expect(codes(RARE_CITY_WORLD_DEFINITION)).toEqual([])
    const lower = clone(RARE_CITY_WORLD_DEFINITION)
    lower.collections[0].contract = lower.collections[0].contract.toLowerCase()
    expect(codes(lower)).toEqual([])
  })

  it('rare-city refuses any other definition', () => {
    const variants: [string, (d: Json) => void][] = [
      ['another collection', (d) => (d.collections[0].contract = ALPHA)],
      ['another collection key', (d) => (d.collections[0].key = 'friends')],
      ['an extra collection', (d) => d.collections.push({ key: 'beta', chain: 'eip155:4663', contract: BETA, standard: 'erc721' })],
      ['a different spacing', (d) => (d.layout.params.plotSpacing = 5.3)],
      ['a ward limit', (d) => (d.layout.maxWards = 10)],
      ['a renamed layout', (d) => (d.layout.key = 'other')],
      ['a narrower district', (d) => (d.layout.districts[0].spanDeg = 39)],
      ['a turned district', (d) => { d.layout.districts[0].centerDeg = -135.5; d.layout.districts[0].spanDeg = 39 }],
      ['one district fewer', (d) => { d.districts.pop(); d.layout.districts.pop() }],
      ['districts reordered', (d) => d.districts.reverse()],
      ['property building ids', (d) => (d.buildingIds = 'property-v1')],
    ]
    for (const [name, change] of variants) {
      const d = clone(RARE_CITY_WORLD_DEFINITION)
      change(d)
      const got = codes(d)
      // A change that breaks the token-v1 rule on its own is refused for that reason first.
      expect(got.length > 0 && (got.includes('world-id-reserved') || got.includes('building-ids')), name).toBe(true)
    }
  })

  it('the legacy definition under a brand id is refused: token-v1 belongs to rare-city', () => {
    expect(codes({ ...clone(RARE_CITY_WORLD_DEFINITION), worldId: BRAND_A })).toEqual(['building-ids'])
    expect(codes({ ...clone(RARE_CITY_WORLD_DEFINITION), worldId: BRAND_A, buildingIds: 'property-v1' })).toEqual([])
  })
})

/** Every object reachable from `value` is frozen, and none is a Map or Set. */
function assertDeepFrozen(value: unknown, path = 'world') {
  if (typeof value !== 'object' || value === null) return
  expect(value instanceof Map || value instanceof Set, path).toBe(false)
  expect(Object.isFrozen(value), path).toBe(true)
  for (const [k, v] of Object.entries(value)) assertDeepFrozen(v, `${path}.${k}`)
}

describe('compiled worlds are immutable', () => {
  it('a compiled world is frozen all the way down and exposes no mutable lookup', () => {
    assertDeepFrozen(compileWorldOrThrow(definition()))
    assertDeepFrozen(RARE_CITY_WORLD, 'RARE_CITY_WORLD')
    assertDeepFrozen(RARE_CITY_WORLD_DEFINITION, 'RARE_CITY_WORLD_DEFINITION')
    expect(Object.keys(RARE_CITY_WORLD).sort()).toEqual(['buildingIds', 'collections', 'districts', 'id', 'layout'])
  })

  it('the shared legacy fixture cannot be changed', () => {
    expect(() => (RARE_CITY_WORLD.districts as District[]).push(RARE_CITY_WORLD.districts[0])).toThrow(TypeError)
    expect(() => ((RARE_CITY_WORLD.layout.params as { plotSpacing: number }).plotSpacing = 1)).toThrow(TypeError)
    expect(() => ((RARE_CITY_WORLD_DEFINITION.layout.params.rowOffsets as number[])[0] = 1)).toThrow(TypeError)
    expect(RARE_CITY_WORLD.layout.params.plotSpacing).toBe(5.2)
  })

  it("changing the caller's input afterwards changes nothing, and unknown fields are dropped", () => {
    const def = clone(definition())
    def.layout.params.extra = { nested: { v: 1 } }
    const world = compileWorldOrThrow(def)
    const before = JSON.stringify(world)
    def.layout.params.rowOffsets.push(23)
    def.layout.params.plotSpacing = 1
    def.layout.params.extra.nested.v = 2
    def.layout.districts[0].spanDeg = 1
    def.collections[0].contract = BETA
    def.districts.push({ key: 'late' })
    expect(JSON.stringify(world)).toBe(before)
    expect(Object.keys(world.layout.params).sort()).toEqual(['coreWardInner', 'coreWardOuter', 'firstPlotRadius', 'marginDeg', 'plotSpacing', 'rowOffsets', 'wardDepth'])
  })

  it('reads the input once: a getter cannot pass validation with one value and compile another', () => {
    let reads = 0
    const params: Record<string, unknown> = { ...PARAMS }
    Object.defineProperty(params, 'plotSpacing', { enumerable: true, get: () => (++reads === 1 ? 5.2 : -1) })
    const world = compileWorldOrThrow({ ...definition(), layout: { ...definition().layout, params } })
    expect(reads).toBe(1)
    expect(world.layout.params.plotSpacing).toBe(5.2)
    // And the reverse: a bad first read fails, whatever later reads would say.
    let second = 0
    const bad: Record<string, unknown> = { ...PARAMS }
    Object.defineProperty(bad, 'plotSpacing', { enumerable: true, get: () => (++second === 1 ? -1 : 5.2) })
    expect(codes({ ...definition(), layout: { ...definition().layout, params: bad } })).toContain('layout-params')
  })

  it('only a compiled world is accepted by the lookups', () => {
    const world = compileWorldOrThrow(definition())
    const copy = JSON.parse(JSON.stringify(world)) as World
    expect(isWorld(world)).toBe(true)
    expect(isWorld(copy)).toBe(false)
    expect(() => districtOf(copy, 'north')).toThrow(/compiled world/)
    expect(() => resolvePlot(copy, 'north-w0-p0')).toThrow(/compiled world/)
    expect(() => worldProperty({ ...world }, asset(ALPHA, '1'))).toThrow(/compiled world/)
  })

  it('refuses input that is not plain data', () => {
    expect(codes({ ...definition(), extra: 1n })).toEqual(['definition'])
    const cyclic = clone(definition())
    cyclic.self = cyclic
    expect(codes(cyclic)).toEqual(['definition'])
    expect(codes(undefined)).toEqual(['definition'])
  })
})

type District = World['districts'][number]

describe('resource limits keep every plot addressable', () => {
  it('refuses spacing so small that a district would hold too many plots', () => {
    for (const plotSpacing of [1e-9, 1e-4, 0.001]) expect(new Set(codes(definition({ params: { plotSpacing } }))), String(plotSpacing)).toEqual(new Set(['layout-capacity']))
  })

  it('refuses a ward limit the plot budget or the plot-id grammar cannot hold', () => {
    expect(new Set(codes(definition({ maxWards: 1_000 })))).toEqual(new Set(['layout-capacity']))
    expect(codes(definition({ maxWards: 1_000_001 }))).toEqual(['layout-max-wards'])
    expect(codes(definition({ maxWards: 50 }))).toEqual([])
  })

  it('refuses oversized definitions', () => {
    expect(codes(definition({ keys: Array.from({ length: WORLD_LIMITS.districts + 1 }, (_, i) => `k${i}`), params: { marginDeg: 0.1 } }))).toContain('districts')
    expect(codes(definition({ keys: Array.from({ length: WORLD_LIMITS.districts }, (_, i) => `k${i}`), params: { marginDeg: 0.1 } }))).toEqual([])
    expect(codes(definition({ params: { rowOffsets: Array.from({ length: 17 }, (_, i) => 1 + i) } }))).toContain('layout-params')
    const many = { ...definition(), collections: Array.from({ length: WORLD_LIMITS.collections + 1 }, (_, i) => ({ key: `c${i}`, chain: 'eip155:1', contract: '0x' + i.toString(16).padStart(40, '0'), standard: 'erc721' })) }
    expect(codes(many)).toContain('collections')
    expect(codes({ ...definition(), padding: 'x'.repeat(WORLD_LIMITS.definitionBytes) })).toEqual(['definition-size'])
  })

  it('an unbounded layout stops where the next ward would overflow the plot budget', () => {
    const world = compileWorldOrThrow(definition())
    const d = world.districts[0]
    let total = 0
    for (let w = 0; w < world.layout.wardLimit; w++) total += wardCapacityOf(world, d, w)
    expect(total).toBeLessThanOrEqual(WORLD_LIMITS.plotsPerDistrict)
    expect(total + wardCapacityOf(world, d, world.layout.wardLimit)).toBeGreaterThan(WORLD_LIMITS.plotsPerDistrict)
    expect(resolvePlot(world, formatPlotId('north', world.layout.wardLimit, 0))).toBeNull()
    expect(canOpenWard(world, world.layout.wardLimit)).toBe(false)
    expect(RARE_CITY_WORLD.layout.wardLimit).toBe(133)
  })

  it('checks each geometry rule on its own', () => {
    // Outer wards would start inside the previous one, and nothing else is wrong.
    expect(details(definition({ params: { wardDepth: 20, rowOffsets: [3, 8.5, 15.5, 19] } }))).toEqual(['outer wards would place plots inside the previous ward'])
    // A row on (or inside) the ward's own plot radius, and nothing else is wrong.
    for (const lo of [0, -1]) expect(details(definition({ params: { firstPlotRadius: 42, rowOffsets: [lo, 8.5, 15.5, 21] } })), String(lo)).toEqual(['every row offset must lie strictly inside one ward depth'])
  })

  it('every plot offered can be parsed, resolved and chosen, until a bounded district is full', () => {
    const rand = prng(0x2a2a)
    for (let round = 0; round < 6; round++) {
      const n = 1 + Math.floor(rand() * 7)
      const world = compileWorldOrThrow(definition({ keys: Array.from({ length: n }, (_, i) => `k${i}`), params: { plotSpacing: 4 + rand() * 20, marginDeg: rand() * 2 }, maxWards: 1 + Math.floor(rand() * 3) }))
      const key = world.districts[Math.floor(rand() * n)].key
      let occupancy: WorldOccupancy = { openWards: {}, occupied: new Set() }
      for (;;) {
        const candidates = availablePlotsIn(world, occupancy, key)!
        if (candidates.length === 0) break
        for (const c of candidates) {
          expect(parsePlotId(c.plotId)).toEqual({ districtKey: c.districtKey, ward: c.ward, plot: c.plot, plotId: c.plotId })
          expect(resolvePlot(world, c.plotId)).not.toBeNull()
        }
        const pick = candidates[Math.floor(rand() * candidates.length)]
        const choice = choosePlot(world, occupancy, pick.plotId)
        if (!choice.ok) throw new Error(`offered ${pick.plotId} but it cannot be chosen`)
        occupancy = { openWards: { ...occupancy.openWards, [key]: choice.openWards }, occupied: new Set([...occupancy.occupied, pick.plotId]) }
      }
      const open = occupancy.openWards[key] ?? 1
      expect(open).toBe(world.layout.wardLimit)
      let capacity = 0
      for (let w = 0; w < open; w++) capacity += wardCapacityOf(world, districtOf(world, key)!, w)
      expect(occupancy.occupied.size).toBe(capacity)
    }
  })
})

describe('impossible occupancy is refused', () => {
  const world = compileWorldOrThrow(definition())
  const full = new Set(Array.from({ length: wardCapacityOf(world, districtOf(world, 'north')!, 0) }, (_, p) => formatPlotId('north', 0, p)))

  it('a sound occupancy has no problems', () => {
    expect(occupancyProblems(world, { openWards: { north: 2 }, occupied: new Set([...full, 'north-w1-p3']) })).toEqual([])
  })

  it.each([
    ['a building in a ward that is not open', { openWards: {}, occupied: new Set([...full, 'north-w1-p4']) }],
    ['an unknown district in openWards', { openWards: { nowhere: 1 }, occupied: new Set() }],
    ['more open wards than the layout allows', { openWards: { north: world.layout.wardLimit + 1 }, occupied: new Set() }],
    ['zero open wards', { openWards: { north: 0 }, occupied: new Set() }],
    ['a fraction of a ward', { openWards: { north: 1.5 }, occupied: new Set() }],
    ['a plot of an unknown district', { openWards: {}, occupied: new Set(['zz-w0-p0']) }],
    ['a plot beyond its ward', { openWards: {}, occupied: new Set(['north-w0-p9999']) }],
    ['a misspelled plot', { openWards: {}, occupied: new Set(['North-w0-p0']) }],
    ['a plot that is not text', { openWards: {}, occupied: new Set([7]) }],
    ['occupied as a list', { openWards: {}, occupied: ['north-w0-p0'] }],
    ['openWards as a list', { openWards: [1], occupied: new Set() }],
  ])('%s', (_, occupancy) => {
    expect(occupancyProblems(world, occupancy).length).toBeGreaterThan(0)
    expect(() => availablePlotsIn(world, occupancy as WorldOccupancy, 'north')).toThrow(/Impossible occupancy/)
    expect(() => choosePlot(world, occupancy as WorldOccupancy, 'north-w1-p4')).toThrow(/Impossible occupancy/)
  })
})

describe('geometry fingerprints', () => {
  it('GOLDEN: the legacy fixture (computed independently from the documented text)', () => {
    expect(districtOf(RARE_CITY_WORLD, 'd4')!.geometryFingerprint).toBe('0214cf7743ece9fb78c1cc3ae3d037021c849f189c4ad2b3ac0f0b826a111150')
    expect(RARE_CITY_WORLD.layout.geometryFingerprint).toBe('362cd5965694bbd8b7fa433092d3b52fd7a449d32a7287922ab3bdbc4e9dedde')
  })

  it('do not change with anything that leaves every plot where it is', () => {
    const base = compileWorldOrThrow(definition())
    const same = [
      definition({ worldId: BRAND_B }),
      definition({ maxWards: 5 }),
      { ...definition(), layout: { ...definition().layout, key: 'renamed' } },
      { ...definition(), collections: [{ key: 'beta', chain: 'eip155:1', contract: BETA, standard: 'erc721' }] },
      { ...definition(), districts: [...definition().districts].reverse(), layout: { ...definition().layout, districts: [...definition().layout.districts].reverse() } },
    ]
    for (const d of same) expect(compileWorldOrThrow(d).layout.geometryFingerprint).toBe(base.layout.geometryFingerprint)
  })

  it('change with anything that moves or renumbers a plot, and only in the district it touches', () => {
    const base = compileWorldOrThrow(definition())
    for (const params of [{ plotSpacing: 5.3 }, { marginDeg: 2 }, { rowOffsets: [3, 8.5, 15.5, 20] }, { firstPlotRadius: 41 }, { wardDepth: 25 }, { coreWardInner: 21 }, { coreWardOuter: 63 }])
      expect(compileWorldOrThrow(definition({ params })).layout.geometryFingerprint, JSON.stringify(params)).not.toBe(base.layout.geometryFingerprint)
    const moved = compileWorldOrThrow({ ...definition(), layout: { ...definition().layout, districts: definition().layout.districts.map((g, i) => (i === 0 ? { ...g, centerDeg: g.centerDeg + 1, spanDeg: 88 } : g)) } })
    expect(moved.layout.geometryFingerprint).not.toBe(base.layout.geometryFingerprint)
    expect(moved.districts.map((d) => d.geometryFingerprint === base.districts[d.index].geometryFingerprint)).toEqual([false, true, true, true])
    // Shrinking one wedge to make room for a new district leaves the others untouched.
    const grown = compileWorldOrThrow({
      ...definition(),
      districts: [...definition().districts, { key: 'new' }],
      layout: { ...definition().layout, districts: [...definition().layout.districts.map((g, i) => (i === 3 ? { ...g, centerDeg: g.centerDeg - 22.5, spanDeg: 45 } : g)), { district: 'new', centerDeg: 112.5, spanDeg: 45 }] },
    })
    expect(grown.districts.slice(0, 3).map((d) => d.geometryFingerprint)).toEqual(base.districts.slice(0, 3).map((d) => d.geometryFingerprint))
    expect(grown.layout.geometryFingerprint).not.toBe(base.layout.geometryFingerprint)
  })
})
