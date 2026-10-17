import { canonicalAddress, isBrandWorldId, isPermanentKey, parseChainRef, parseUint256 } from '../../world/identity'
import { deepFreeze } from '../../world/freeze'
import { vetMediaRef } from './media'

/**
 * BRAND CITY CONFIGURATION: the small, standard surface a brand may configure.
 *
 * A brand chooses WHAT the standard Rare City game shows, never how it plays or looks:
 *   - city name, brand name and logo, capital name and crest
 *   - the participating NFT collections
 *   - how many districts (within `BRAND_LIMITS`), their names and accent colours
 *   - per district: an optional District Monument NFT and an optional Proofy rule reference
 *
 * Deliberately absent: layout geometry, ward sizes, buildings, tiers, monuments' rules,
 * progression, prices, currency and anything else that is game mechanics. Those are the
 * same for every brand.
 *
 * NOT A PROOFY PLAY CONTRACT. This is the shape the preview validates; the real integration
 * will map Proofy Play's community configuration onto it (see `ProofyRuleRef`).
 */
export interface BrandCollectionConfig {
  /** Permanent key within the city. */
  key: string
  /** CAIP-2 chain, e.g. `eip155:8453`. */
  chain: string
  contract: string
  displayName: string
}

/** The NFT a district's monument carries. Its artwork is a vetted media reference (see media.ts). */
export interface MonumentNftConfig {
  /** Key of one of the city's collections. */
  collection: string
  /** Canonical decimal token id. */
  tokenId: string
  /** Vetted artwork reference, or null: the monument then shows the standard fallback. */
  artwork: string | null
}

/**
 * A reference to a rule that already exists in Proofy Core: a Verification Rule
 * (`verification_rules.id`, a positive integer scoped to one Discord server). The city never
 * evaluates it; Proofy Core does, server-side (today `POST /api/v1/access/check` with
 * `checkType: "rule"`). `source: 'sample'` marks the preview's made-up references, which name
 * no real rule. Proofy Play has no rule-reference contract yet, so this mirrors Core only.
 */
export interface ProofyRuleRef {
  source: 'sample' | 'proofy-core'
  verificationRuleId: number
  /** Human label shown to members, e.g. "Verified Captain role". */
  label: string
}

export interface BrandDistrictConfig {
  key: string
  name: string
  /** `#rrggbb`. */
  accent: string
  monument: MonumentNftConfig | null
  /** Who may claim and build here. null: every otherwise eligible member. */
  gate: ProofyRuleRef | null
}

export interface BrandCityConfig {
  /** The city's world id (a canonical lowercase UUID). */
  worldId: string
  cityName: string
  brand: { name: string; logo: string | null }
  capital: { name: string; crest: string | null }
  collections: BrandCollectionConfig[]
  districts: BrandDistrictConfig[]
}

/**
 * Sizes the standard renderer supports. Fewer than three wedges stop reading as a city;
 * more than nine make wedges narrower than the art was drawn for (civic squares, monuments,
 * street furniture). These are presentation limits, not engine limits.
 */
export const BRAND_LIMITS = deepFreeze({
  minDistricts: 3,
  maxDistricts: 9,
  collections: 8,
  nameLength: 32,
  labelLength: 64,
})

export interface ConfigProblem {
  path: string
  detail: string
}

export type ParsedBrandConfig = { ok: true; config: Readonly<BrandCityConfig> } | { ok: false; problems: ConfigProblem[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const ACCENT = /^#[0-9a-f]{6}$/
// Printable text only: no control characters, no bidi overrides.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

/**
 * Validate a brand configuration that arrived as untyped data. Every problem is reported.
 * The input is read once, as JSON, so later changes to the caller's objects cannot reach
 * the result, which is deep-frozen.
 */
export function parseBrandCityConfig(input: unknown): ParsedBrandConfig {
  let data: unknown
  try {
    const text = JSON.stringify(input)
    if (text === undefined) throw new Error('not JSON')
    data = JSON.parse(text)
  } catch {
    return { ok: false, problems: [{ path: '', detail: 'the configuration is not plain JSON data' }] }
  }
  const problems: ConfigProblem[] = []
  const add = (path: string, detail: string) => problems.length < 50 && problems.push({ path, detail })
  if (!isRecord(data)) return { ok: false, problems: [{ path: '', detail: 'the configuration is not an object' }] }

  const text = (path: string, v: unknown, max: number): string => {
    if (typeof v !== 'string' || v.trim() !== v || v.length === 0 || v.length > max || UNSAFE_TEXT.test(v)) {
      add(path, `must be 1 to ${max} printable characters with no surrounding spaces`)
      return ''
    }
    return v
  }
  const media = (path: string, v: unknown): string | null => {
    if (v === null) return null
    const vetted = vetMediaRef(v)
    if (!vetted.ok) {
      add(path, `media reference refused (${vetted.problem}); use a /brand-media/ path or a raster data: URL`)
      return null
    }
    return vetted.href
  }

  if (!isBrandWorldId(data.worldId)) add('worldId', 'must be a canonical lowercase UUID')
  const cityName = text('cityName', data.cityName, BRAND_LIMITS.nameLength)
  const brandIn = isRecord(data.brand) ? data.brand : (add('brand', 'must be an object'), {})
  const brand = { name: text('brand.name', brandIn.name, BRAND_LIMITS.nameLength), logo: media('brand.logo', brandIn.logo ?? null) }
  const capitalIn = isRecord(data.capital) ? data.capital : (add('capital', 'must be an object'), {})
  const capital = { name: text('capital.name', capitalIn.name, BRAND_LIMITS.nameLength), crest: media('capital.crest', capitalIn.crest ?? null) }

  const collections: BrandCollectionConfig[] = []
  if (!Array.isArray(data.collections) || data.collections.length === 0 || data.collections.length > BRAND_LIMITS.collections)
    add('collections', `must list 1 to ${BRAND_LIMITS.collections} collections`)
  else
    data.collections.forEach((c: unknown, i: number) => {
      const path = `collections[${i}]`
      if (!isRecord(c)) return void add(path, 'must be an object')
      const chain = parseChainRef(c.chain)
      const contract = canonicalAddress(c.contract)
      if (!isPermanentKey(c.key)) add(`${path}.key`, 'is not a permanent key')
      else if (collections.some((x) => x.key === c.key)) add(`${path}.key`, `collection ${c.key} is listed twice`)
      if (!chain) add(`${path}.chain`, 'is not an eip155 CAIP-2 chain')
      if (!contract) add(`${path}.contract`, 'is not an address')
      else if (chain && collections.some((x) => x.chain === chain.text && x.contract === contract)) add(`${path}.contract`, 'repeats another collection')
      const displayName = text(`${path}.displayName`, c.displayName, BRAND_LIMITS.nameLength)
      if (isPermanentKey(c.key) && chain && contract) collections.push({ key: c.key, chain: chain.text, contract, displayName })
    })

  const districts: BrandDistrictConfig[] = []
  if (!Array.isArray(data.districts) || data.districts.length < BRAND_LIMITS.minDistricts || data.districts.length > BRAND_LIMITS.maxDistricts)
    add('districts', `must list ${BRAND_LIMITS.minDistricts} to ${BRAND_LIMITS.maxDistricts} districts`)
  else
    data.districts.forEach((d: unknown, i: number) => {
      const path = `districts[${i}]`
      if (!isRecord(d)) return void add(path, 'must be an object')
      if (!isPermanentKey(d.key)) add(`${path}.key`, 'is not a permanent key')
      else if (districts.some((x) => x.key === d.key)) add(`${path}.key`, `district ${d.key} is listed twice`)
      const name = text(`${path}.name`, d.name, BRAND_LIMITS.nameLength)
      const accent = typeof d.accent === 'string' && ACCENT.test(d.accent) ? d.accent : (add(`${path}.accent`, 'must be #rrggbb in lowercase'), '#888888')
      let monument: MonumentNftConfig | null = null
      if (d.monument !== null && d.monument !== undefined) {
        const m = isRecord(d.monument) ? d.monument : (add(`${path}.monument`, 'must be an object or null'), null)
        if (m) {
          const tokenId = parseUint256(m.tokenId)
          if (typeof m.collection !== 'string' || !(data.collections as unknown[]).some((c) => isRecord(c) && c.key === m.collection))
            add(`${path}.monument.collection`, 'is not one of this city\'s collections')
          if (!tokenId) add(`${path}.monument.tokenId`, 'is not a canonical decimal token id')
          const artwork = media(`${path}.monument.artwork`, m.artwork ?? null)
          if (typeof m.collection === 'string' && tokenId) monument = { collection: m.collection, tokenId, artwork }
        }
      }
      let gate: ProofyRuleRef | null = null
      if (d.gate !== null && d.gate !== undefined) {
        const g = isRecord(d.gate) ? d.gate : (add(`${path}.gate`, 'must be an object or null'), null)
        if (g) {
          const ruleId = g.verificationRuleId
          const validId = typeof ruleId === 'number' && Number.isSafeInteger(ruleId) && ruleId > 0
          if (g.source !== 'sample' && g.source !== 'proofy-core') add(`${path}.gate.source`, "must be 'sample' or 'proofy-core'")
          if (!validId) add(`${path}.gate.verificationRuleId`, 'is not a positive integer (a Proofy Core verification rule id)')
          const label = text(`${path}.gate.label`, g.label, BRAND_LIMITS.labelLength)
          if ((g.source === 'sample' || g.source === 'proofy-core') && validId) gate = { source: g.source, verificationRuleId: ruleId, label }
        }
      }
      if (isPermanentKey(d.key)) districts.push({ key: d.key, name, accent, monument, gate })
    })

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, config: deepFreeze({ worldId: data.worldId as string, cityName, brand, capital, collections, districts }) }
}
