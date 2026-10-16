import { sha256, stringToBytes } from 'viem'
import { contractRefOf, type TokenStandard } from './asset'
import { deepFreeze } from './freeze'
import { canonicalAddress, isBrandWorldId, isPermanentKey, LEGACY_RARE_CITY_WORLD_ID, parseChainRef } from './identity'
import { plotRowsFor } from './layout'
import { RARE_CITY_WORLD_DEFINITION } from './legacy'

/**
 * WORLD DEFINITIONS: what a configurable city is made of, as plain data.
 *
 * A trusted caller supplies a definition; `compileWorld` copies it once, validates the copy
 * completely and returns a deep-frozen `World` that every engine operation takes. Nothing
 * here reads a database, a chain or a clock, and nothing here chooses a district count, a
 * layout or an allocation rule: those arrive in the definition.
 *
 * Deliberately absent: labels, colours and art (presentation), which NFT goes to which
 * district (assignment), economy, seasons and tickets.
 */

export interface DistrictDefinition {
  /** Permanent key. Plot ids are spelled with it, so it never changes once a plot exists. */
  key: string
}

export interface CollectionDefinition {
  /** Permanent key within the world. */
  key: string
  /** CAIP-2, e.g. `eip155:4663`. */
  chain: string
  /** Contract address; stored lowercase. */
  contract: string
  standard: TokenStandard
}

/**
 * Parameters of the radial-wedge layout family, in world units and degrees. Every district
 * is a wedge around a central plaza; each ward is a ring band of the wedge holding rows of
 * plots. The legacy Rare Friends city is one preset of this family.
 */
export interface RadialWedgeParams {
  /** Inner and outer radius of ward 0 (the district core). */
  coreWardInner: number
  coreWardOuter: number
  /** Radius where ward 0's plot rows are measured from; ward N's is `firstPlotRadius + N * wardDepth`. */
  firstPlotRadius: number
  /** Radial depth of every ward after the first. */
  wardDepth: number
  /** Radii of the plot rows inside a ward, as offsets from its plot radius. Strictly increasing. */
  rowOffsets: readonly number[]
  /** Minimum arc distance between plot centres in a row. */
  plotSpacing: number
  /** Angle kept clear on each side of a wedge (boundary avenues). */
  marginDeg: number
}

export interface DistrictGeometry {
  /** The district key this wedge belongs to. */
  district: string
  /** Centre angle of the wedge, in degrees, within `WORLD_LIMITS.centerDeg` of 0. Kept exactly as given. */
  centerDeg: number
  /** Full angular width of the wedge, in degrees. */
  spanDeg: number
}

export interface LayoutDefinition {
  kind: 'radial-wedge'
  /** Permanent key naming this layout preset. */
  key: string
  params: RadialWedgeParams
  /** Exactly one wedge per district of the world. */
  districts: readonly DistrictGeometry[]
  /** How many wards a district may ever have open, or null for as many as `WORLD_LIMITS` allow. */
  maxWards: number | null
}

/**
 * How a building in this world's state is keyed.
 * - `token-v1`     `b-<token id>`: the legacy Rare Friends form, reserved for the legacy definition.
 * - `property-v1`  `b-<property id>`: one key per (world, NFT), whatever the number of collections. Every brand world uses it.
 */
export type BuildingIdScheme = 'token-v1' | 'property-v1'

export interface WorldDefinition {
  /** Supplied by a trusted caller: a brand world's UUID, or `rare-city` for the legacy definition only. */
  worldId: string
  /** In display and lookup order. Any number from one, under any permanent keys. */
  districts: readonly DistrictDefinition[]
  collections: readonly CollectionDefinition[]
  layout: LayoutDefinition
  buildingIds: BuildingIdScheme
}

/**
 * Resource bounds. They keep every computation small and every plot addressable: a plot id
 * spells its ward and plot with at most six digits, and no district can hold more plots
 * than `plotsPerDistrict`, so no ward or plot index can reach a million. They are limits on
 * size, not product decisions: the district count is the definition's.
 */
export const WORLD_LIMITS = deepFreeze({
  /** Longest definition, as UTF-8 JSON: Play's configuration limit (64 KiB). */
  definitionBytes: 65_536,
  districts: 64,
  collections: 64,
  rowOffsets: 16,
  /** Wedge centres lie within one turn either way of 0 degrees. */
  centerDeg: 360,
  /** Plots one district may hold across every ward it may open. Bounds every availability list. */
  plotsPerDistrict: 100_000,
  /** Ward indices a plot id can spell (0..999999). */
  wards: 1_000_000,
})

export interface District {
  readonly key: string
  /** Position in the definition's order, from 0. */
  readonly index: number
  readonly centerDeg: number
  readonly spanDeg: number
  /** See `DISTRICT_GEOMETRY_PREFIX`. */
  readonly geometryFingerprint: string
}

export interface Collection {
  readonly key: string
  readonly chain: string
  readonly chainId: number
  readonly contract: `0x${string}`
  readonly standard: TokenStandard
}

export interface CompiledLayout {
  readonly kind: 'radial-wedge'
  readonly key: string
  /** As defined. */
  readonly maxWards: number | null
  /** Wards a district may ever have: `maxWards`, or for an unbounded layout the most `WORLD_LIMITS` allow in every district. */
  readonly wardLimit: number
  readonly params: Readonly<RadialWedgeParams>
  /** See `LAYOUT_GEOMETRY_PREFIX`. */
  readonly geometryFingerprint: string
}

/** A validated, deep-frozen world. Only `compileWorld` makes one, and the lookups accept nothing else. */
export interface World {
  readonly id: string
  readonly districts: readonly District[]
  readonly collections: readonly Collection[]
  readonly layout: CompiledLayout
  readonly buildingIds: BuildingIdScheme
}

export interface WorldProblem {
  /** Stable short name of the rule that failed. */
  code: string
  detail: string
}

export type CompiledWorld = { ok: true; world: World } | { ok: false; problems: WorldProblem[] }

/**
 * GEOMETRY FINGERPRINTS. Lowercase hex SHA-256 of UTF-8 text:
 *
 *   proofy-world:district-geometry:v1|<JSON [kind, district key, centerDeg, spanDeg, coreWardInner,
 *                                     coreWardOuter, firstPlotRadius, wardDepth, rowOffsets, plotSpacing, marginDeg]>
 *   proofy-world:layout-geometry:v1|<JSON [[district key, district fingerprint], ...] sorted by key>
 *
 * Numbers are spelled as JavaScript's JSON.stringify spells them. A district's fingerprint
 * covers everything that decides which plots its plot ids name and where they stand, so a
 * persistence layer that stores it beside a district's first plot can prove later that the
 * geometry has not changed. It deliberately leaves out `maxWards`, the layout key, the
 * district order and everything outside the layout: none of them moves a plot. (A lower
 * ward limit can still strand stored plots; check those with `resolvePlot`.)
 */
export const DISTRICT_GEOMETRY_PREFIX = 'proofy-world:district-geometry:v1'
export const LAYOUT_GEOMETRY_PREFIX = 'proofy-world:layout-geometry:v1'

const MAX_PROBLEMS = 50
const EPSILON = 1e-9
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPositive = (v: unknown): v is number => isFiniteNumber(v) && v > 0
const hex = (text: string) => sha256(stringToBytes(text)).slice(2)

type Add = (code: string, detail: string) => void

interface Indexes {
  districts: ReadonlyMap<string, District>
  collections: ReadonlyMap<string, Collection>
  /** Keyed by `contractRefOf`. */
  byContract: ReadonlyMap<string, Collection>
}

/** Lookups live here, out of the caller's reach, keyed by the frozen world they index. */
const INDEXES = new WeakMap<World, Indexes>()

function indexesOf(world: World): Indexes {
  const indexes = INDEXES.get(world)
  if (!indexes) throw new Error('Not a compiled world: only compileWorld makes one.')
  return indexes
}

/** True for a `World` that `compileWorld` made. */
export function isWorld(value: unknown): value is World {
  return typeof value === 'object' && value !== null && INDEXES.has(value as World)
}

/** A validated definition, before it is frozen into a `World`. */
interface Parts {
  worldId: string
  districts: { key: string; centerDeg: number; spanDeg: number }[]
  collections: Collection[]
  layout: { kind: 'radial-wedge'; key: string; maxWards: number | null; wardLimit: number; params: RadialWedgeParams }
  buildingIds: BuildingIdScheme
}

type Built = { ok: true; parts: Parts } | { ok: false; problems: WorldProblem[] }

/**
 * Validate a definition that arrived as untyped data, and compile it. Every problem is
 * reported, not just the first. The input is read exactly once (as JSON), so getters,
 * proxies and later changes to the caller's objects cannot reach the compiled world.
 */
export function compileWorld(input: unknown): CompiledWorld {
  const copy = snapshot(input)
  if (!copy.ok) return { ok: false, problems: [copy.problem] }
  const built = build(copy.value)
  if (!built.ok) return built
  if (built.parts.worldId === LEGACY_RARE_CITY_WORLD_ID && shapeOf(built.parts) !== legacyShape())
    return { ok: false, problems: [{ code: 'world-id-reserved', detail: `${LEGACY_RARE_CITY_WORLD_ID} is reserved for the legacy Rare Friends definition, and this is a different definition` }] }
  return { ok: true, world: assemble(built.parts) }
}

/** `compileWorld` for definitions that are part of this build (fixtures, presets): a problem is a programming error. */
export function compileWorldOrThrow(input: unknown): World {
  const compiled = compileWorld(input)
  if (!compiled.ok) throw new Error(`Invalid world definition: ${compiled.problems.map((p) => `${p.code}: ${p.detail}`).join('; ')}`)
  return compiled.world
}

function snapshot(input: unknown): { ok: true; value: unknown } | { ok: false; problem: WorldProblem } {
  let text: string | undefined
  try {
    text = JSON.stringify(input)
  } catch {
    text = undefined
  }
  if (text === undefined) return { ok: false, problem: { code: 'definition', detail: 'the definition is not plain JSON data' } }
  if (stringToBytes(text).length > WORLD_LIMITS.definitionBytes) return { ok: false, problem: { code: 'definition-size', detail: `the definition is longer than ${WORLD_LIMITS.definitionBytes} bytes of JSON` } }
  return { ok: true, value: JSON.parse(text) }
}

function build(input: unknown): Built {
  const problems: WorldProblem[] = []
  const add: Add = (code, detail) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ code, detail })
  }
  if (!isRecord(input)) return { ok: false, problems: [{ code: 'definition', detail: 'the definition is not an object' }] }
  const { worldId, districts, collections, layout, buildingIds } = input

  if (!(worldId === LEGACY_RARE_CITY_WORLD_ID || isBrandWorldId(worldId))) add('world-id', 'worldId is not a lowercase UUID')
  if (buildingIds !== 'token-v1' && buildingIds !== 'property-v1') add('building-ids', 'buildingIds is not a known scheme')
  else if (buildingIds === 'token-v1' && worldId !== LEGACY_RARE_CITY_WORLD_ID) add('building-ids', 'token-v1 building ids are reserved for the legacy Rare Friends world; brand worlds use property-v1')

  // Districts: at least one, each a permanent key, no repeats.
  const districtKeys: string[] = []
  if (!Array.isArray(districts) || districts.length === 0) add('districts', 'districts is not a non-empty list')
  else if (districts.length > WORLD_LIMITS.districts) add('districts', `a world has at most ${WORLD_LIMITS.districts} districts`)
  else
    for (const d of districts) {
      const key = isRecord(d) ? d.key : undefined
      if (!isPermanentKey(key)) add('district-key', `${JSON.stringify(key)} is not a permanent key`)
      else if (districtKeys.includes(key)) add('district-duplicate', `district ${key} is listed twice`)
      else districtKeys.push(key)
    }

  // Collections: at least one; keys unique; one contract never appears under two keys.
  const compiledCollections: Collection[] = []
  if (!Array.isArray(collections) || collections.length === 0) add('collections', 'collections is not a non-empty list')
  else if (collections.length > WORLD_LIMITS.collections) add('collections', `a world has at most ${WORLD_LIMITS.collections} collections`)
  else
    for (const c of collections) {
      if (!isRecord(c)) {
        add('collection', 'a collection is not an object')
        continue
      }
      const chain = parseChainRef(c.chain)
      const contract = canonicalAddress(c.contract)
      if (!isPermanentKey(c.key)) add('collection-key', `${JSON.stringify(c.key)} is not a permanent key`)
      if (!chain) add('collection-chain', `collection ${String(c.key)}: chain is not an eip155 CAIP-2 reference`)
      if (!contract) add('collection-contract', `collection ${String(c.key)}: contract is not an address`)
      if (c.standard !== 'erc721') add('collection-standard', `collection ${String(c.key)}: only erc721 is supported`)
      if (!isPermanentKey(c.key) || !chain || !contract || c.standard !== 'erc721') continue
      const collection: Collection = { key: c.key, chain: chain.text, chainId: chain.chainId, contract, standard: 'erc721' }
      if (compiledCollections.some((x) => x.key === collection.key)) add('collection-duplicate', `collection ${collection.key} is listed twice`)
      else if (compiledCollections.some((x) => contractRefOf(x) === contractRefOf(collection))) add('collection-contract-duplicate', `collection ${collection.key} repeats the contract of another collection`)
      else compiledCollections.push(collection)
    }

  // Layout.
  const geometry = new Map<string, DistrictGeometry>()
  let params: RadialWedgeParams | null = null
  let maxWards: number | null = null
  if (!isRecord(layout)) add('layout', 'layout is not an object')
  else {
    if (layout.kind !== 'radial-wedge') add('layout-kind', 'layout kind is not radial-wedge')
    if (!isPermanentKey(layout.key)) add('layout-key', 'layout key is not a permanent key')
    if (layout.maxWards === null) maxWards = null
    else if (Number.isSafeInteger(layout.maxWards) && (layout.maxWards as number) >= 1 && (layout.maxWards as number) <= WORLD_LIMITS.wards) maxWards = layout.maxWards as number
    else add('layout-max-wards', `maxWards is neither null nor a whole number from 1 to ${WORLD_LIMITS.wards}`)
    params = checkParams(layout.params, add)
    const marginDeg = params?.marginDeg ?? 0
    if (!Array.isArray(layout.districts)) add('layout-districts', 'layout districts is not a list')
    else if (layout.districts.length > WORLD_LIMITS.districts) add('layout-districts', `a layout has at most ${WORLD_LIMITS.districts} wedges`)
    else {
      for (const g of layout.districts) {
        if (!isRecord(g) || typeof g.district !== 'string') {
          add('layout-district', 'a wedge does not name a district')
          continue
        }
        if (!districtKeys.includes(g.district)) add('layout-district-unknown', `a wedge names ${JSON.stringify(g.district)}, which is not a district of this world`)
        else if (geometry.has(g.district)) add('layout-district-duplicate', `district ${g.district} has two wedges`)
        else if (!isFiniteNumber(g.centerDeg) || Math.abs(g.centerDeg) > WORLD_LIMITS.centerDeg || !isPositive(g.spanDeg) || g.spanDeg > 360)
          add('layout-wedge', `district ${g.district}: the wedge's centre is not within ${WORLD_LIMITS.centerDeg} degrees of 0, or its span is not in (0, 360]`)
        else if (g.spanDeg / 2 - marginDeg <= 0) add('layout-wedge', `district ${g.district}: the margins leave no room for plots`)
        else geometry.set(g.district, { district: g.district, centerDeg: g.centerDeg, spanDeg: g.spanDeg })
      }
      for (const key of districtKeys) if (!geometry.has(key) && !(layout.districts as unknown[]).some((g) => isRecord(g) && g.district === key)) add('layout-district-missing', `district ${key} has no wedge`)
      checkOverlap([...geometry.values()], add)
    }
  }

  if (problems.length > 0 || !params) return { ok: false, problems: problems.length > 0 ? problems : [{ code: 'layout-params', detail: 'layout params are unusable' }] }

  // Capacity: every district must fit `plotsPerDistrict` across every ward it may open.
  const limits = new Map<number, number | null>()
  let wardLimit = maxWards ?? WORLD_LIMITS.wards
  for (const key of districtKeys) {
    const { spanDeg } = geometry.get(key)!
    if (!limits.has(spanDeg)) limits.set(spanDeg, wardLimitFor(params, spanDeg, maxWards))
    const limit = limits.get(spanDeg)!
    if (limit === null)
      add('layout-capacity', maxWards === null ? `district ${key}: its first ward alone holds more than ${WORLD_LIMITS.plotsPerDistrict} plots` : `district ${key}: ${maxWards} wards would hold more than ${WORLD_LIMITS.plotsPerDistrict} plots`)
    else wardLimit = Math.min(wardLimit, limit)
  }
  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    parts: {
      worldId: worldId as string,
      districts: districtKeys.map((key) => ({ key, centerDeg: geometry.get(key)!.centerDeg, spanDeg: geometry.get(key)!.spanDeg })),
      collections: compiledCollections,
      layout: { kind: 'radial-wedge', key: (layout as Record<string, unknown>).key as string, maxWards, wardLimit, params },
      buildingIds: buildingIds as BuildingIdScheme,
    },
  }
}

/**
 * The most wards a district `spanDeg` wide may have, within `maxWards` (or `WORLD_LIMITS.wards`)
 * and `plotsPerDistrict`; null when even the wards it must allow do not fit. Capacity grows
 * with the ward index, so the first ward that overflows ends the count.
 */
function wardLimitFor(params: RadialWedgeParams, spanDeg: number, maxWards: number | null): number | null {
  const cap = maxWards ?? WORLD_LIMITS.wards
  let total = 0
  for (let ward = 0; ward < cap; ward++) {
    for (const row of plotRowsFor(params, spanDeg, ward)) total += row.count
    // Written so that NaN and Infinity also count as overflowing.
    if (!(total <= WORLD_LIMITS.plotsPerDistrict)) return maxWards === null && ward > 0 ? ward : null
  }
  return cap
}

/**
 * The radial-wedge parameters must describe plots that actually sit in their ward: for every
 * ward N, each plot row lies strictly inside N's band. Ward N's plot radius minus its band's
 * inner (or outer) edge does not depend on N, so three comparisons cover every ward.
 * Returns a fresh copy of exactly the known fields, or null.
 */
function checkParams(params: unknown, add: Add): RadialWedgeParams | null {
  if (!isRecord(params)) {
    add('layout-params', 'layout params is not an object')
    return null
  }
  const { coreWardInner, coreWardOuter, firstPlotRadius, wardDepth, rowOffsets, plotSpacing, marginDeg } = params
  let ok = true
  const fail = (detail: string) => {
    ok = false
    add('layout-params', detail)
  }
  for (const [name, v] of Object.entries({ coreWardInner, coreWardOuter, firstPlotRadius, wardDepth, plotSpacing })) if (!isPositive(v)) fail(`${name} is not a positive number`)
  if (!isFiniteNumber(marginDeg) || marginDeg < 0) fail('marginDeg is not a non-negative number')
  if (!Array.isArray(rowOffsets) || rowOffsets.length === 0 || rowOffsets.length > WORLD_LIMITS.rowOffsets || !rowOffsets.every(isFiniteNumber)) {
    fail(`rowOffsets is not a list of 1 to ${WORLD_LIMITS.rowOffsets} numbers`)
    return null
  }
  for (let i = 1; i < rowOffsets.length; i++) if (!(rowOffsets[i] > rowOffsets[i - 1])) fail('rowOffsets is not strictly increasing')
  if (!ok) return null
  const [inner, outer, first, depth] = [coreWardInner, coreWardOuter, firstPlotRadius, wardDepth] as number[]
  const lo = rowOffsets[0] as number
  const hi = rowOffsets[rowOffsets.length - 1] as number
  if (!(lo > 0 && hi < depth)) fail('every row offset must lie strictly inside one ward depth')
  if (!(first + lo > inner)) fail('ward 0 plots would reach inside the core ward')
  if (!(first + hi < outer)) fail('plots would reach past the outer edge of their ward')
  if (!(first + depth + lo > outer)) fail('outer wards would place plots inside the previous ward')
  if (!ok) return null
  return { coreWardInner: inner, coreWardOuter: outer, firstPlotRadius: first, wardDepth: depth, rowOffsets: [...(rowOffsets as number[])], plotSpacing: plotSpacing as number, marginDeg: marginDeg as number }
}

/** Wedges may touch but never overlap, and together fit in one turn. */
function checkOverlap(wedges: DistrictGeometry[], add: Add) {
  const mod = (a: number) => ((a % 360) + 360) % 360
  const total = wedges.reduce((sum, w) => sum + w.spanDeg, 0)
  if (total > 360 + EPSILON) add('layout-overlap', `the wedges span ${total} degrees in all`)
  for (let i = 0; i < wedges.length; i++)
    for (let j = i + 1; j < wedges.length; j++) {
      const a = wedges[i]
      const b = wedges[j]
      const a0 = mod(a.centerDeg - a.spanDeg / 2)
      const b0 = mod(b.centerDeg - b.spanDeg / 2)
      // Two arcs overlap exactly when one starts strictly inside the other (going round). Touching ends is fine.
      if (mod(b0 - a0) < a.spanDeg - EPSILON || mod(a0 - b0) < b.spanDeg - EPSILON) add('layout-overlap', `the wedges of ${a.district} and ${b.district} overlap`)
    }
}

/** Every validated fact of a definition, in one canonical text. Two definitions with the same shape compile to the same world. */
function shapeOf(parts: Parts): string {
  const p = parts.layout.params
  return JSON.stringify([
    parts.worldId,
    parts.districts.map((d) => [d.key, d.centerDeg, d.spanDeg]),
    parts.collections.map((c) => [c.key, c.chain, c.contract, c.standard]),
    [parts.layout.kind, parts.layout.key, parts.layout.maxWards, p.coreWardInner, p.coreWardOuter, p.firstPlotRadius, p.wardDepth, p.rowOffsets, p.plotSpacing, p.marginDeg],
    parts.buildingIds,
  ])
}

let legacyShapeText: string | undefined
function legacyShape(): string {
  if (legacyShapeText === undefined) {
    const copy = snapshot(RARE_CITY_WORLD_DEFINITION)
    const built = copy.ok ? build(copy.value) : null
    if (!built?.ok) throw new Error('The legacy Rare Friends definition no longer compiles.')
    legacyShapeText = shapeOf(built.parts)
  }
  return legacyShapeText
}

function districtFingerprint(kind: string, p: RadialWedgeParams, d: { key: string; centerDeg: number; spanDeg: number }): string {
  return hex(`${DISTRICT_GEOMETRY_PREFIX}|${JSON.stringify([kind, d.key, d.centerDeg, d.spanDeg, p.coreWardInner, p.coreWardOuter, p.firstPlotRadius, p.wardDepth, p.rowOffsets, p.plotSpacing, p.marginDeg])}`)
}

function assemble(parts: Parts): World {
  const { kind, key, maxWards, wardLimit, params } = parts.layout
  const districts: District[] = parts.districts.map((d, index) => ({ key: d.key, index, centerDeg: d.centerDeg, spanDeg: d.spanDeg, geometryFingerprint: districtFingerprint(kind, params, d) }))
  const sorted = [...districts].sort((a, b) => (a.key < b.key ? -1 : 1)).map((d) => [d.key, d.geometryFingerprint])
  const world: World = deepFreeze({
    id: parts.worldId,
    districts,
    collections: parts.collections,
    layout: { kind, key, maxWards, wardLimit, params, geometryFingerprint: hex(`${LAYOUT_GEOMETRY_PREFIX}|${JSON.stringify(sorted)}`) },
    buildingIds: parts.buildingIds,
  })
  INDEXES.set(world, {
    districts: new Map(world.districts.map((d) => [d.key, d])),
    collections: new Map(world.collections.map((c) => [c.key, c])),
    byContract: new Map(world.collections.map((c) => [contractRefOf(c), c])),
  })
  return world
}

/** A district of the world by key, or null. */
export function districtOf(world: World, key: unknown): District | null {
  const indexes = indexesOf(world)
  return typeof key === 'string' ? (indexes.districts.get(key) ?? null) : null
}

/** A collection of the world by key, or null. */
export function collectionOf(world: World, key: unknown): Collection | null {
  const indexes = indexesOf(world)
  return typeof key === 'string' ? (indexes.collections.get(key) ?? null) : null
}

/** The world's collection that an NFT belongs to, or null when the NFT is not from any of them. */
export function collectionForAsset(world: World, asset: { chain: string; contract: string; standard: TokenStandard }): Collection | null {
  const indexes = indexesOf(world)
  const contract = canonicalAddress(asset.contract)
  if (!contract) return null
  return indexes.byContract.get(contractRefOf({ chain: asset.chain, standard: asset.standard, contract })) ?? null
}
