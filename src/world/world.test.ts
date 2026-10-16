import { describe, expect, it } from 'vitest'
import { parsePlotId as legacyParsePlotId } from '../protocol/activation'
import { assetKey, contractRefOf, nftAsset, sameAsset } from './asset'
import { collectionForAsset, collectionOf, compileWorld, compileWorldOrThrow, districtOf, type World, type WorldDefinition } from './definition'
import { canonicalAddress, isPermanentKey, isWorldId, MAX_UINT256, parseChainRef, parseUint256 } from './identity'
import { canOpenWard, plotPointOf, wardCapacityOf } from './layout'
import { availablePlotsIn, choosePlot, formatPlotId, parseWorldPlotKey, resolvePlot, worldPlotKey, type WorldOccupancy } from './plots'
import { worldProperty, worldPropertyIdPreimage } from './property'

/**
 * New-world behaviour. Every world here is invented for the test: none is a product
 * decision about district counts, layouts or keys.
 */
const BRAND_A = '01890a5d-ac96-774b-bcce-b302099a8057'
const BRAND_B = '01890a5d-ac96-774b-bcce-b302099a8058'
const ALPHA = '0x' + 'a1'.repeat(20)
const BETA = '0x' + 'b2'.repeat(20)

const PARAMS = { coreWardInner: 22, coreWardOuter: 64, firstPlotRadius: 40, wardDepth: 24, rowOffsets: [3, 8.5, 15.5, 21], plotSpacing: 5.2, marginDeg: 3 }

/** Districts as equal wedges round the plaza, for tests. */
function definition(patch: Partial<WorldDefinition> & { keys?: string[] } = {}): WorldDefinition {
  const keys = patch.keys ?? ['north', 'harbor-front', 'old-town', 'z9']
  const span = 360 / keys.length
  return {
    worldId: BRAND_A,
    districts: keys.map((key) => ({ key })),
    collections: [{ key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }],
    layout: { kind: 'radial-wedge', key: 'test-ring', params: PARAMS, districts: keys.map((key, i) => ({ district: key, centerDeg: i * span, spanDeg: span })), maxWards: null },
    buildingIds: 'property-v1',
    ...patch,
  }
}

const empty: WorldOccupancy = { openWards: {}, occupied: new Set() }
const asset = (contract: string, tokenId: string, chain = 'eip155:8453') => nftAsset({ chain, contract, tokenId })!

describe('world identity', () => {
  it('two brands with identical definitions are independent worlds', () => {
    const a = compileWorldOrThrow(definition({ worldId: BRAND_A }))
    const b = compileWorldOrThrow(definition({ worldId: BRAND_B }))
    expect(a.id).not.toBe(b.id)
    const plot = resolvePlot(a, 'north-w0-p3')!
    expect(worldPlotKey(a, plot)).toBe(`${BRAND_A}:north-w0-p3`)
    expect(worldPlotKey(a, plot)).not.toBe(worldPlotKey(b, plot))
    // The same NFT is a different property in each.
    const nft = asset(ALPHA, '812')
    const pa = worldProperty(a, nft)!
    const pb = worldProperty(b, nft)!
    expect(pa.assetKey).toBe(pb.assetKey)
    expect(pa.propertyId).not.toBe(pb.propertyId)
    expect(pa.buildingId).not.toBe(pb.buildingId)
  })

  it('a world id is the legacy world or a lowercase UUID, nothing else', () => {
    for (const ok of ['rare-city', BRAND_A]) expect(isWorldId(ok), ok).toBe(true)
    for (const bad of ['', 'Rare-City', 'brand-a', BRAND_A.toUpperCase(), `${BRAND_A} `, '01890a5dac96774bbcceb302099a8057', 7, null]) expect(isWorldId(bad), String(bad)).toBe(false)
    expect(compileWorld(definition({ worldId: 'brand-a' }))).toMatchObject({ ok: false, problems: [{ code: 'world-id' }] })
  })

  it('world-scoped plot keys parse back', () => {
    expect(parseWorldPlotKey(`${BRAND_A}:harbor-front-w2-p10`)).toEqual({ worldId: BRAND_A, plot: { districtKey: 'harbor-front', ward: 2, plot: 10, plotId: 'harbor-front-w2-p10' } })
    expect(parseWorldPlotKey('rare-city:d4-w0-p7')).toEqual({ worldId: 'rare-city', plot: { districtKey: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7' } })
    for (const bad of ['d4-w0-p7', 'brand:d4-w0-p7', `${BRAND_A}:`, `${BRAND_A}:D4-w0-p7`, `${BRAND_A}::d4-w0-p7`, 42]) expect(parseWorldPlotKey(bad), String(bad)).toBeNull()
  })
})

describe('NFT asset identity', () => {
  it('identical token ids in two collections do not collide', () => {
    const world = compileWorldOrThrow(definition({ collections: [{ key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }, { key: 'beta', chain: 'eip155:8453', contract: BETA, standard: 'erc721' }] }))
    const a = asset(ALPHA, '812')
    const b = asset(BETA, '812')
    expect(sameAsset(a, b)).toBe(false)
    expect(assetKey(a)).toBe(`eip155:8453/erc721:${ALPHA}/812`)
    expect(collectionForAsset(world, a)?.key).toBe('alpha')
    expect(collectionForAsset(world, b)?.key).toBe('beta')
    const pa = worldProperty(world, a)!
    const pb = worldProperty(world, b)!
    expect(pa.propertyId).not.toBe(pb.propertyId)
    expect(pa.buildingId).not.toBe(pb.buildingId)
    expect(pa.buildingId).toBe(`b-${pa.propertyId}`)
    expect(pa.buildingId).toMatch(/^b-[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('the same contract on two chains is two collections', () => {
    const world = compileWorldOrThrow(definition({ collections: [{ key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }, { key: 'alpha-l1', chain: 'eip155:1', contract: ALPHA, standard: 'erc721' }] }))
    expect(worldProperty(world, asset(ALPHA, '1', 'eip155:1'))!.collection.key).toBe('alpha-l1')
    expect(worldProperty(world, asset(ALPHA, '1'))!.propertyId).not.toBe(worldProperty(world, asset(ALPHA, '1', 'eip155:1'))!.propertyId)
  })

  it('address case never makes two assets or two collections', () => {
    const upper = '0x' + 'A1'.repeat(20)
    expect(assetKey(asset(upper, '5'))).toBe(assetKey(asset(ALPHA, '5')))
    const world = compileWorldOrThrow(definition())
    expect(collectionForAsset(world, { chain: 'eip155:8453', contract: upper, standard: 'erc721' })?.key).toBe('alpha')
    expect(compileWorld(definition({ collections: [{ key: 'alpha', chain: 'eip155:8453', contract: ALPHA, standard: 'erc721' }, { key: 'again', chain: 'eip155:8453', contract: upper, standard: 'erc721' }] }))).toMatchObject({ ok: false, problems: [{ code: 'collection-contract-duplicate' }] })
  })

  it('very large ERC-721 token ids keep every digit', () => {
    const max = MAX_UINT256.toString()
    expect(max).toBe('115792089237316195423570985008687907853269984665640564039457584007913129639935')
    expect(parseUint256(max)).toBe(max)
    expect(parseUint256((MAX_UINT256 + 1n).toString())).toBeNull()
    const world = compileWorldOrThrow(definition())
    const big = worldProperty(world, asset(ALPHA, max))!
    expect(big.asset.tokenId).toBe(max)
    expect(worldPropertyIdPreimage(world.id, big.asset).endsWith(`/erc721:${ALPHA}/${max}`)).toBe(true)
    // 2^53 and 2^53 + 1 are one JavaScript number, but two tokens.
    expect(2 ** 53 === 2 ** 53 + 1).toBe(true)
    const p53 = worldProperty(world, asset(ALPHA, '9007199254740992'))!
    const p53b = worldProperty(world, asset(ALPHA, '9007199254740993'))!
    expect(p53.propertyId).not.toBe(p53b.propertyId)
    expect(p53b.assetKey.endsWith('/9007199254740993')).toBe(true)
  })

  it('derives a property id only from a world id and a canonical asset', () => {
    const nft = asset(ALPHA, '812')
    // `rare-city` is the legacy namespace, which only Rare Friends are in.
    for (const worldId of ['brand-a', 'rare-city|x', '', 'rare-city', BRAND_A.toUpperCase()]) expect(() => worldPropertyIdPreimage(worldId, nft), worldId).toThrow()
    for (const forged of [{ ...nft, tokenId: '0812' }, { ...nft, tokenId: '812|token=1' }, { ...nft, contract: ('0x' + 'A1'.repeat(20)) as `0x${string}` }, { ...nft, chain: 'eip155:1|x' }])
      expect(() => worldPropertyIdPreimage(BRAND_A, forged), JSON.stringify(forged)).toThrow()
    expect(worldPropertyIdPreimage(BRAND_A, nft)).toBe(`proofy-world:property:v2|world=${BRAND_A}|asset=eip155:8453/erc721:${ALPHA}/812`)
  })

  it('refuses token ids that are not canonical decimal text', () => {
    for (const bad of [812, 812n, '0812', '+812', '-1', '812.0', '1e3', '0x32c', ' 812', '812 ', '', '8_12', null]) expect(parseUint256(bad), String(bad)).toBeNull()
    expect(nftAsset({ chain: 'eip155:8453', contract: ALPHA, tokenId: 812 })).toBeNull()
    expect(nftAsset({ chain: 'eip155:8453', contract: ALPHA, tokenId: '812', standard: 'erc1155' })).toBeNull()
    expect(parseUint256('0')).toBe('0')
  })

  it('chains are CAIP-2 eip155 references; addresses are 20 bytes', () => {
    expect(parseChainRef('eip155:4663')).toEqual({ namespace: 'eip155', chainId: 4663, text: 'eip155:4663' })
    for (const bad of ['4663', 'eip155:04663', 'eip155:0', 'EIP155:1', 'solana:mainnet', 'eip155:99999999999999999', 'eip155:1 ']) expect(parseChainRef(bad), bad).toBeNull()
    for (const bad of ['0x' + 'a'.repeat(39), 'a1'.repeat(20), '0x' + 'g'.repeat(40), ` ${ALPHA}`]) expect(canonicalAddress(bad), bad).toBeNull()
    expect(contractRefOf(asset(ALPHA, '1'))).toBe(`eip155:8453/erc721:${ALPHA}`)
  })
})

describe('configured districts', () => {
  it('arbitrary district keys work and do not inherit the d1-d9 restriction', () => {
    const world = compileWorldOrThrow(definition())
    expect(world.districts.map((d) => d.key)).toEqual(['north', 'harbor-front', 'old-town', 'z9'])
    expect(districtOf(world, 'harbor-front')).toMatchObject({ key: 'harbor-front', index: 1 })
    expect(districtOf(world, 'd4')).toBeNull()
    expect(legacyParsePlotId('harbor-front-w0-p3')).toBeNull()
    expect(resolvePlot(world, 'harbor-front-w0-p3')).toEqual({ districtKey: 'harbor-front', ward: 0, plot: 3, plotId: 'harbor-front-w0-p3' })
    expect(resolvePlot(world, 'd4-w0-p3')).toBeNull()
  })

  it('a key that looks like a plot suffix still parses one way only', () => {
    const world = compileWorldOrThrow(definition({ keys: ['east-w1', 'west'] }))
    expect(resolvePlot(world, 'east-w1-w0-p2')).toEqual({ districtKey: 'east-w1', ward: 0, plot: 2, plotId: 'east-w1-w0-p2' })
    expect(formatPlotId('east-w1', 0, 2)).toBe('east-w1-w0-p2')
  })

  it('refuses keys that are not permanent keys', () => {
    for (const ok of ['d1', 'north', 'harbor-front', 'z9', 'a'.repeat(32)]) expect(isPermanentKey(ok), ok).toBe(true)
    for (const bad of ['D1', '1d', 'a_b', 'a--b', '-a', 'a-', 'a b', '', 'é', 'a'.repeat(33), 7]) expect(isPermanentKey(bad), String(bad)).toBe(false)
    expect(compileWorld(definition({ keys: ['north', 'North'] }))).toMatchObject({ ok: false })
  })

  it('works for any number of districts, and wider wedges hold more plots', () => {
    for (const n of [1, 2, 3, 5, 12, 24]) {
      const keys = Array.from({ length: n }, (_, i) => `k${i}`)
      const compiled = compileWorld(definition({ keys }))
      expect(compiled.ok, `${n} districts`).toBe(true)
      if (!compiled.ok) continue
      const world = compiled.world
      expect(world.districts).toHaveLength(n)
      for (const d of world.districts) expect(availablePlotsIn(world, empty, d.key)!.length).toBe(wardCapacityOf(world, d, 0))
    }
    const narrow = compileWorldOrThrow(definition({ keys: Array.from({ length: 12 }, (_, i) => `k${i}`) }))
    const wide = compileWorldOrThrow(definition({ keys: ['a', 'b', 'c'] }))
    expect(wardCapacityOf(wide, wide.districts[0], 0)).toBeGreaterThan(wardCapacityOf(narrow, narrow.districts[0], 0))
  })

  it('uneven wedges are allowed when they do not overlap', () => {
    const world = compileWorldOrThrow({ ...definition({ keys: ['big', 'small'] }), layout: { ...definition().layout, districts: [{ district: 'big', centerDeg: 0, spanDeg: 90 }, { district: 'small', centerDeg: 70, spanDeg: 30 }] } })
    expect(wardCapacityOf(world, districtOf(world, 'big')!, 0)).toBeGreaterThan(wardCapacityOf(world, districtOf(world, 'small')!, 0))
    // Plots stay inside their own wedge.
    for (const d of world.districts) for (let p = 0; p < wardCapacityOf(world, d, 0); p++) {
      const pt = plotPointOf(world, d, 0, p)
      const deg = (Math.atan2(pt.y, pt.x) * 180) / Math.PI
      expect(Math.abs(((deg - d.centerDeg + 540) % 360) - 180)).toBeLessThan(d.spanDeg / 2)
    }
  })
})

describe('ward capacity and expansion from the layout', () => {
  const fill = (world: World, occupancy: WorldOccupancy, key: string, ward: number): WorldOccupancy => {
    const occupied = new Set(occupancy.occupied)
    for (let p = 0; p < wardCapacityOf(world, districtOf(world, key)!, ward); p++) occupied.add(formatPlotId(key, ward, p))
    return { ...occupancy, occupied }
  }

  it('an unbounded layout previews the next ward when the open ones are full', () => {
    const world = compileWorldOrThrow(definition())
    const full = fill(world, empty, 'north', 0)
    const preview = availablePlotsIn(world, full, 'north')!
    expect(preview.length).toBe(wardCapacityOf(world, districtOf(world, 'north')!, 1))
    expect(preview.every((c) => c.ward === 1 && c.newWard)).toBe(true)
    expect(choosePlot(world, full, 'north-w1-p4')).toEqual({ ok: true, plot: { districtKey: 'north', ward: 1, plot: 4, plotId: 'north-w1-p4' }, openedWard: true, openWards: 2 })
    // Only that district's preview changes.
    expect(availablePlotsIn(world, full, 'z9')!.every((c) => c.ward === 0)).toBe(true)
    expect(choosePlot(world, full, 'north-w2-p0')).toEqual({ ok: false, reason: 'plot-unavailable' })
  })

  it('a bounded layout stops opening wards at maxWards', () => {
    const world = compileWorldOrThrow(definition({ layout: { ...definition().layout, maxWards: 2 } }))
    expect([0, 1, 2].map((n) => canOpenWard(world, n))).toEqual([true, true, false])
    let occ = fill(world, empty, 'north', 0)
    expect(availablePlotsIn(world, occ, 'north')!.every((c) => c.newWard && c.ward === 1)).toBe(true)
    occ = fill(world, { ...occ, openWards: { north: 2 } }, 'north', 1)
    expect(availablePlotsIn(world, occ, 'north')).toEqual([])
    expect(choosePlot(world, occ, 'north-w2-p0')).toEqual({ ok: false, reason: 'unknown-plot' })
    expect(resolvePlot(world, 'north-w2-p0')).toBeNull()
    expect(() => availablePlotsIn(world, { openWards: { north: 3 }, occupied: new Set() }, 'north')).toThrow()
  })

  it('refuses impossible occupancy rather than guess', () => {
    const world = compileWorldOrThrow(definition())
    for (const open of [0, -1, 1.5, Number.NaN]) expect(() => availablePlotsIn(world, { openWards: { north: open }, occupied: new Set() }, 'north'), String(open)).toThrow()
    expect(availablePlotsIn(world, empty, 'nowhere')).toBeNull()
    // Lookups are own-property only: a district may be called what Object.prototype calls things.
    const odd = compileWorldOrThrow(definition({ keys: ['constructor', 'to-string'] }))
    expect(availablePlotsIn(odd, empty, 'constructor')!.length).toBe(wardCapacityOf(odd, districtOf(odd, 'constructor')!, 0))
    expect(availablePlotsIn(odd, empty, 'hasOwnProperty')).toBeNull()
  })
})

describe('world definition validation', () => {
  const problems = (def: unknown) => {
    const compiled = compileWorld(def)
    return compiled.ok ? [] : compiled.problems.map((p) => p.code)
  }
  const base = definition()

  it('accepts a sound definition, and compiles to a frozen copy the input cannot change', () => {
    const def = definition()
    const world = compileWorldOrThrow(def)
    ;(def.layout.params.rowOffsets as number[]).push(23)
    ;(def.districts as { key: string }[]).push({ key: 'late' })
    expect(world.layout.params.rowOffsets).toEqual([3, 8.5, 15.5, 21])
    expect(world.districts).toHaveLength(4)
    expect(Object.isFrozen(world)).toBe(true)
    expect(Object.isFrozen(world.districts[0])).toBe(true)
    expect(collectionOf(world, 'alpha')?.contract).toBe(ALPHA)
  })

  it.each([
    ['not an object', null, 'definition'],
    ['no districts', { ...base, districts: [] }, 'districts'],
    ['repeated district', definition({ keys: ['a', 'a'] }), 'district-duplicate'],
    ['bad district key', definition({ keys: ['A'] }), 'district-key'],
    ['no collections', { ...base, collections: [] }, 'collections'],
    ['repeated collection key', { ...base, collections: [base.collections[0], { ...base.collections[0], contract: BETA }] }, 'collection-duplicate'],
    ['bad chain', { ...base, collections: [{ ...base.collections[0], chain: '8453' }] }, 'collection-chain'],
    ['bad contract', { ...base, collections: [{ ...base.collections[0], contract: '0x12' }] }, 'collection-contract'],
    ['unsupported standard', { ...base, collections: [{ ...base.collections[0], standard: 'erc1155' }] }, 'collection-standard'],
    ['token-v1 with two collections', { ...base, buildingIds: 'token-v1', collections: [base.collections[0], { ...base.collections[0], key: 'beta', contract: BETA }] }, 'building-ids'],
    ['token-v1 in a brand world, even with one collection', { ...base, buildingIds: 'token-v1' }, 'building-ids'],
    ['centre beyond one turn', { ...base, layout: { ...base.layout, districts: base.layout.districts.map((g, i) => (i === 0 ? { ...g, centerDeg: 361 } : g)) } }, 'layout-wedge'],
    ['astronomical centre', { ...base, layout: { ...base.layout, districts: base.layout.districts.map((g, i) => (i === 0 ? { ...g, centerDeg: 1e17 } : g)) } }, 'layout-wedge'],
    ['unknown building scheme', { ...base, buildingIds: 'b-token' }, 'building-ids'],
    ['unknown layout kind', { ...base, layout: { ...base.layout, kind: 'grid' } }, 'layout-kind'],
    ['bad layout key', { ...base, layout: { ...base.layout, key: 'Ring' } }, 'layout-key'],
    ['bad maxWards', { ...base, layout: { ...base.layout, maxWards: 0 } }, 'layout-max-wards'],
    ['district without a wedge', { ...base, layout: { ...base.layout, districts: base.layout.districts.slice(1) } }, 'layout-district-missing'],
    ['wedge for an unknown district', { ...base, layout: { ...base.layout, districts: [...base.layout.districts, { district: 'elsewhere', centerDeg: 0, spanDeg: 1 }] } }, 'layout-district-unknown'],
    ['two wedges for one district', { ...base, layout: { ...base.layout, districts: [...base.layout.districts, base.layout.districts[0]] } }, 'layout-district-duplicate'],
    ['overlapping wedges', { ...base, layout: { ...base.layout, districts: base.layout.districts.map((g, i) => (i === 1 ? { ...g, centerDeg: g.centerDeg - 10 } : g)) } }, 'layout-overlap'],
    ['identical wedges', definition({ keys: ['a', 'b'], layout: { ...base.layout, districts: [{ district: 'a', centerDeg: 10, spanDeg: 40 }, { district: 'b', centerDeg: -350, spanDeg: 40 }] } }), 'layout-overlap'],
    ['margins leave no room', { ...base, layout: { ...base.layout, params: { ...PARAMS, marginDeg: 45 } } }, 'layout-wedge'],
    ['zero span', { ...base, layout: { ...base.layout, districts: base.layout.districts.map((g, i) => (i === 0 ? { ...g, spanDeg: 0 } : g)) } }, 'layout-wedge'],
    ['non-positive radius', { ...base, layout: { ...base.layout, params: { ...PARAMS, wardDepth: 0 } } }, 'layout-params'],
    ['rows not increasing', { ...base, layout: { ...base.layout, params: { ...PARAMS, rowOffsets: [3, 3, 15] } } }, 'layout-params'],
    ['rows outside the ward', { ...base, layout: { ...base.layout, params: { ...PARAMS, rowOffsets: [3, 30] } } }, 'layout-params'],
    ['plots inside the core', { ...base, layout: { ...base.layout, params: { ...PARAMS, firstPlotRadius: 10 } } }, 'layout-params'],
    ['plots past the ward edge', { ...base, layout: { ...base.layout, params: { ...PARAMS, coreWardOuter: 55 } } }, 'layout-params'],
    ['negative margin', { ...base, layout: { ...base.layout, params: { ...PARAMS, marginDeg: -1 } } }, 'layout-params'],
  ])('refuses: %s', (_, def, code) => {
    expect(problems(def)).toContain(code)
    expect(() => compileWorldOrThrow(def)).toThrow(/Invalid world definition/)
  })

  it('touching wedges are fine, all the way round', () => {
    expect(problems(definition({ keys: Array.from({ length: 9 }, (_, i) => `d${i + 1}`) }))).toEqual([])
    expect(problems(definition({ keys: ['solo'] }))).toEqual([])
  })

  it('reports every problem, not only the first', () => {
    expect(problems({ ...base, worldId: 'x', buildingIds: 'nope', districts: [] }).length).toBeGreaterThanOrEqual(3)
  })
})
