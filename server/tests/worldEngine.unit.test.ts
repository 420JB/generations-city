import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compileWorldOrThrow, districtOf, formatPlotId, nftAsset, RARE_CITY_WORLD, rareFriendAsset, uuidV8FromText, worldProperty, worldPropertyIdPreimage } from '../../src/world'
import { ownershipEraId, PROPERTY_WORLD, propertyId, propertyIdPreimage } from '../src/activation/propertyId'
import { plotId } from '../src/engine'

/**
 * The portable world engine (src/world) against the server's frozen V1 identity code.
 * The server's `propertyId` (node:crypto) is the authority; the world engine must give the
 * Rare Friends world exactly the same ids, for every Friend.
 */
describe('world engine: V1 property ids for the Rare Friends world', () => {
  it('names the same world', () => {
    expect(RARE_CITY_WORLD.id).toBe(PROPERTY_WORLD)
  })

  it('builds the same preimage and the same id for 5,000 Friends and the largest supported one', () => {
    const tokens = [...Array.from({ length: 5_000 }, (_, i) => String(i)), '9007199254740991']
    for (const token of tokens) {
      const asset = rareFriendAsset(token)!
      expect(worldPropertyIdPreimage(RARE_CITY_WORLD.id, asset)).toBe(propertyIdPreimage(token))
      expect(worldProperty(RARE_CITY_WORLD, asset)?.propertyId).toBe(propertyId(token))
    }
  })

  it('the portable UUID derivation equals the server one on other preimages too', () => {
    const property = propertyId('812')
    // ownershipEraId is uuidV8 over its own preimage: the same construction, reachable without private access.
    expect(uuidV8FromText(`rare-city:ownership-era:v1|property=${property}|era=1`)).toBe(ownershipEraId(property, 1))
    expect(uuidV8FromText(`rare-city:ownership-era:v1|property=${property}|era=2`)).toBe(ownershipEraId(property, 2))
  })

  it('spells plot ids as the server engine does', () => {
    for (const d of RARE_CITY_WORLD.districts) expect(formatPlotId(d.key, 3, 11)).toBe(plotId(d.key as Parameters<typeof plotId>[0], 3, 11))
  })
})

/** The V2 construction written out again with node:crypto, from its documentation alone. */
function v2PropertyId(world: string, chain: string, contract: string, token: string): string {
  const bytes = createHash('sha256').update(`proofy-world:property:v2|world=${world}|asset=${chain}/erc721:${contract.toLowerCase()}/${token}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe('world engine: V2 property ids for brand worlds', () => {
  const BRAND = '01890a5d-ac96-774b-bcce-b302099a8057'
  const ALPHA = '0x' + 'a1'.repeat(20)

  it('GOLDEN: the pinned vectors', () => {
    expect(v2PropertyId(BRAND, 'eip155:8453', ALPHA, '812')).toBe('cc965359-c42b-8708-8d24-70c89a5d34fe')
    expect(v2PropertyId(BRAND, 'eip155:4663', '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D', '812')).toBe('a2ddd362-eb6f-82f5-9dde-21aea0cee269')
    expect(v2PropertyId(BRAND, 'eip155:8453', ALPHA, ((1n << 256n) - 1n).toString())).toBe('69b2bc87-24d4-885a-80d8-61c144f30d56')
  })

  it('the portable engine agrees with node:crypto on 2,000 assorted assets', () => {
    let seed = 7
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    const worlds = new Map<string, ReturnType<typeof compileWorldOrThrow>>()
    for (let i = 0; i < 2_000; i++) {
      const world = `01890a5d-ac96-774b-bcce-${next().toString(16).padStart(12, '0').slice(-12)}`
      const chain = `eip155:${1 + (next() % 100_000)}`
      const contract = '0x' + Array.from({ length: 5 }, () => next().toString(16).padStart(8, '0')).join('')
      const token = i % 3 === 0 ? BigInt.asUintN(256, (BigInt(next()) << 224n) | BigInt(next())).toString() : String(next())
      const key = `${world}|${chain}|${contract}`
      if (!worlds.has(key))
        worlds.set(key, compileWorldOrThrow({ worldId: world, districts: [{ key: 'a' }], collections: [{ key: 'c', chain, contract, standard: 'erc721' }], layout: { kind: 'radial-wedge', key: 'l', params: { coreWardInner: 22, coreWardOuter: 64, firstPlotRadius: 40, wardDepth: 24, rowOffsets: [3, 21], plotSpacing: 5.2, marginDeg: 3 }, districts: [{ district: 'a', centerDeg: 0, spanDeg: 40 }], maxWards: 2 }, buildingIds: 'property-v1' }))
      expect(worldProperty(worlds.get(key)!, nftAsset({ chain, contract, tokenId: token })!)!.propertyId).toBe(v2PropertyId(world, chain, contract, token))
    }
  })

  it('GOLDEN: the legacy fixture geometry fingerprint, from its documented text', () => {
    const fp = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
    const districts = [-135, -95, -55, -15, 25, 65, 105, 145, 185].map((c, i) => [`d${i + 1}`, fp(`proofy-world:district-geometry:v1|${JSON.stringify(['radial-wedge', `d${i + 1}`, c, 40, 22, 64, 40, 24, [3, 8.5, 15.5, 21], 5.2, 3])}`)])
    for (const [key, print] of districts) expect(districtOf(RARE_CITY_WORLD, key)!.geometryFingerprint).toBe(print)
    expect(RARE_CITY_WORLD.layout.geometryFingerprint).toBe(fp(`proofy-world:layout-geometry:v1|${JSON.stringify(districts)}`))
  })
})
