import type { World } from '../../world/definition'
import { canonicalAddress, isPermanentKey, parseChainRef } from '../../world/identity'
import type { BrandCityConfig, ConfigProblem } from './config'
import { compileBrandWorld } from './layout'
import { parsePlayCityConfig } from './playConfig'

/**
 * HOW A PERSISTENT BRAND CITY'S CONFIGURATION MAY CHANGE.
 *
 * A world is founded on one accepted Proofy Play configuration version. What that version
 * fixed is its FOUNDATION, recorded once with the world and never changed: the founding
 * layout and districts (provenance only, see below) and the collections, each collection key
 * and the contract it names.
 *
 * GEOMETRY (the layout key and every district's key and wedge, so the district count and order)
 * decides which ground every plot id names. It is FROZEN BY THE WORLD'S FIRST PROPERTY, not by
 * its founding (locked policy): until a property exists no plot id names any ground, so an admin
 * may change the districts freely; the first successful activation records the geometry that
 * governed it (`world_geometry_freezes`, migration 0008), and from then on nothing can move it.
 *
 * Two questions are asked of every later version, and they are kept apart on purpose:
 *
 *   VERDICT (permanent, recorded once per version): is it a valid city for THIS world? It is
 *     ACCEPTED only if it keeps every founding collection (same key, same chain and contract)
 *     and names no founding contract under another key. It is judged against the foundation's
 *     collections alone, never against other versions or the world's state, so it is the same
 *     whichever launch shows the version first: the order in which Play run tokens are
 *     redeemed, or whether a property was placed in between, cannot change any verdict.
 *     Anything else is REJECTED.
 *
 *   GOVERNING (asked on every launch, never recorded): may this accepted version govern the
 *     world NOW? Only if it also keeps every collection ESTABLISHED by the versions that have
 *     governed the world (its adoptions), with the same contract, and names none of their
 *     contracts under another key; and, once the world's geometry is frozen, only if it draws
 *     exactly that geometry. Collections are additive: once a version that added one has
 *     governed, no version without it (an older one re-activated, or a new one) can govern, and
 *     a launch pinned to such a version is refused, not drawn.
 *
 * A version may change any presentation (names, accents, logo, crest, monuments, rule labels
 * and references) and may add collections; until the first property it may also change the
 * districts. Nothing can ever move a plot that exists or reassign what a collection key means in
 * the world's governing history.
 *
 * Verdicts recorded by an earlier judge are never re-judged (`judged_by` names the judge).
 * `rare-city/play-config-v1+world-evolution-v2` also required the FOUNDING geometry; a version it
 * rejected for that stays rejected, and a corrected configuration arrives as a new Play version.
 *
 * This is deliberately not a migration system: an incompatible configuration is refused,
 * never translated.
 */
export interface WorldFoundation {
  layout: { key: string; geometryFingerprint: string }
  /** In configuration order. Each fingerprint is the engine's district geometry fingerprint. */
  districts: { key: string; geometryFingerprint: string }[]
  collections: FoundationCollection[]
}

export interface FoundationCollection {
  key: string
  /** CAIP-2. */
  chain: string
  /** Lowercase. */
  contract: string
}

/** The foundation a validated configuration and its compiled world would fix. */
export function foundationOf(config: Pick<BrandCityConfig, 'collections'>, world: World): WorldFoundation {
  return {
    layout: { key: world.layout.key, geometryFingerprint: world.layout.geometryFingerprint },
    districts: world.districts.map((d) => ({ key: d.key, geometryFingerprint: d.geometryFingerprint })),
    collections: config.collections.map((c) => ({ key: c.key, chain: c.chain, contract: c.contract })),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))

/**
 * What decides where every plot is: the layout and every district's wedge, in configuration
 * order (the geometry part of a foundation). Frozen by a world's first property.
 */
export interface WorldGeometry {
  layout: { key: string; geometryFingerprint: string }
  /** In configuration order. Each fingerprint is the engine's district geometry fingerprint. */
  districts: { key: string; geometryFingerprint: string }[]
}

/** The geometry part of a foundation (or of any geometry), exactly. */
export function geometryOf(value: WorldGeometry): WorldGeometry {
  return { layout: { key: value.layout.key, geometryFingerprint: value.layout.geometryFingerprint }, districts: value.districts.map((d) => ({ key: d.key, geometryFingerprint: d.geometryFingerprint })) }
}

/** Whether two geometries draw the same ground: same layout, same districts, same order. */
export function sameGeometry(a: WorldGeometry, b: WorldGeometry): boolean {
  return JSON.stringify(geometryOf(a)) === JSON.stringify(geometryOf(b))
}

function parseLayout(layout: unknown): WorldGeometry['layout'] | null {
  if (!isRecord(layout) || !exactKeys(layout, ['key', 'geometryFingerprint']) || !isPermanentKey(layout.key) || typeof layout.geometryFingerprint !== 'string' || !HEX64.test(layout.geometryFingerprint)) return null
  return { key: layout.key, geometryFingerprint: layout.geometryFingerprint }
}

function parseDistricts(districts: unknown): WorldGeometry['districts'] | null {
  if (!Array.isArray(districts) || districts.length === 0) return null
  const out: WorldGeometry['districts'] = []
  for (const d of districts) {
    if (!isRecord(d) || !exactKeys(d, ['key', 'geometryFingerprint']) || !isPermanentKey(d.key) || typeof d.geometryFingerprint !== 'string' || !HEX64.test(d.geometryFingerprint)) return null
    if (out.some((x) => x.key === d.key)) return null
    out.push({ key: d.key, geometryFingerprint: d.geometryFingerprint })
  }
  return out
}

/** A stored geometry (a layout as `{ key, geometryFingerprint }` and districts as `foundationOf` makes them), or null. */
export function parseWorldGeometry(layout: unknown, districts: unknown): WorldGeometry | null {
  const l = parseLayout(layout)
  const d = parseDistricts(districts)
  return l && d ? { layout: l, districts: d } : null
}

/** A stored foundation (exactly the shape `foundationOf` makes), or null. */
export function parseWorldFoundation(value: unknown): WorldFoundation | null {
  if (!isRecord(value) || !exactKeys(value, ['layout', 'districts', 'collections'])) return null
  const geometry = parseWorldGeometry(value.layout, value.districts)
  const { collections } = value
  if (!geometry || !Array.isArray(collections) || collections.length === 0) return null
  const outCollections: FoundationCollection[] = []
  for (const c of collections) {
    if (!isRecord(c) || !exactKeys(c, ['key', 'chain', 'contract']) || !isPermanentKey(c.key)) return null
    const chain = parseChainRef(c.chain)
    const contract = canonicalAddress(c.contract)
    if (!chain || !contract || contract !== c.contract) return null
    if (outCollections.some((x) => x.key === c.key)) return null
    outCollections.push({ key: c.key, chain: chain.text, contract })
  }
  return { ...geometry, collections: outCollections }
}

export function sameFoundation(a: WorldFoundation, b: WorldFoundation): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Add = (path: string, detail: string) => void

function collector(): { problems: ConfigProblem[]; add: Add } {
  const problems: ConfigProblem[] = []
  return { problems, add: (path, detail) => void (problems.length < 50 && problems.push({ path, detail })) }
}

/**
 * Why `candidate` would draw other ground than `fixed`, the geometry no version may move (`why` says
 * what fixed it). Empty when it draws exactly that geometry.
 */
export function geometryProblems(fixed: WorldGeometry, candidate: WorldGeometry, why: 'first-property' | 'founding'): ConfigProblem[] {
  const { problems, add } = collector()
  addGeometryProblems(fixed, candidate, why, add)
  return problems
}

function addGeometryProblems(fixed: WorldGeometry, candidate: WorldGeometry, why: 'first-property' | 'founding', add: Add) {
  if (sameGeometry(fixed, candidate)) return
  const when = why === 'founding' ? 'when the city is founded' : 'once the city has its first property'
  const fixedBy = why === 'founding' ? 'was founded' : 'was fixed by its first property'
  const before = new Map(fixed.districts.map((d, i) => [d.key, { ...d, index: i }]))
  const after = new Map(candidate.districts.map((d, i) => [d.key, { ...d, index: i }]))
  let found = false
  const note: Add = (path, detail) => {
    found = true
    add(path, detail)
  }
  if (candidate.layout.key !== fixed.layout.key) note('layout', `the city ${fixedBy} on layout ${fixed.layout.key}; it cannot change`)
  if (candidate.districts.length !== fixed.districts.length) note('districts', `the city ${fixedBy} with ${fixed.districts.length} districts; their number cannot change`)
  const since = why === 'founding' ? '' : ' once the city has its first property'
  for (const key of before.keys()) if (!after.has(key)) note('districts', `district ${key} is part of this city and cannot be removed or renamed${since} (its name can change; its key cannot)`)
  for (const [key, d] of after) {
    const was = before.get(key)
    if (!was) note(`districts[${d.index}].key`, `district ${key} is not one of this city's districts; districts cannot be added${since}`)
    else if (was.geometryFingerprint !== d.geometryFingerprint || was.index !== d.index) note(`districts[${d.index}]`, `district ${key} would move (it stands at position ${was.index + 1}); district positions are fixed ${when}`)
  }
  if (!found) add('districts', `the city's district geometry would change; it is fixed ${when}`)
}

/**
 * Why `candidate` drops or repoints one of the collections `known` (the founding collections for a
 * verdict, the established ones for governing), or names one of their contracts under another key.
 * Empty when it keeps them all.
 */
export function collectionProblems(known: readonly FoundationCollection[], candidate: Pick<WorldFoundation, 'collections'>): ConfigProblem[] {
  const { problems, add } = collector()
  addCollectionProblems(known, candidate, add)
  return problems
}

function addCollectionProblems(known: readonly FoundationCollection[], candidate: Pick<WorldFoundation, 'collections'>, add: Add) {
  const byKey = new Map(candidate.collections.map((c, i) => [c.key, { ...c, index: i }]))
  const seen = new Set<string>()
  for (const k of known) {
    if (seen.has(k.key)) continue
    seen.add(k.key)
    const now = byKey.get(k.key)
    if (!now) add('collections', `collection ${k.key} is part of this city and cannot be removed`)
    else if (now.chain !== k.chain || now.contract !== k.contract) add(`collections[${now.index}]`, `collection ${k.key} names ${k.chain} ${k.contract} in this city; a collection key cannot be pointed at another contract`)
  }
  for (const c of byKey.values()) {
    const other = known.find((k) => k.chain === c.chain && k.contract === c.contract && k.key !== c.key)
    if (other) add(`collections[${c.index}].key`, `this contract is already in this city as collection ${other.key}`)
  }
}

/**
 * The rule of judge world-evolution-v2: `candidate` must keep the FOUNDING geometry and the
 * collections `known`. Kept to check verdicts recorded by that judge; nothing new is judged by it.
 */
export function evolutionProblems(foundation: WorldFoundation, known: readonly FoundationCollection[], candidate: WorldFoundation): ConfigProblem[] {
  const { problems, add } = collector()
  addGeometryProblems(foundation, candidate, 'founding', add)
  addCollectionProblems(known, candidate, add)
  return problems
}

/** What a world (or a world about to be founded) makes of a Play configuration document. */
export type WorldConfigJudgement =
  | { verdict: 'accepted'; config: Readonly<BrandCityConfig>; world: World; foundation: WorldFoundation }
  | { verdict: 'rejected'; code: 'config_invalid' | 'config_incompatible'; problems: ConfigProblem[] }

/** Names this judgement in `world_config_versions.judged_by`. A change to any rule here is a new name. */
export const WORLD_CONFIG_JUDGE = 'rare-city/play-config-v1+world-evolution-v3'
/** The judge before the geometry policy changed (it required the founding geometry). Its verdicts stay as recorded. */
export const WORLD_CONFIG_JUDGE_V2 = 'rare-city/play-config-v1+world-evolution-v2'

/**
 * Judge a Play configuration document (schema version 1) for the world `worldId`.
 * `foundation` is the world's foundation, or null when the document would found the world.
 * The verdict depends on the document and the foundation's collections alone (see above): never on
 * the world's geometry, state or other versions. Pure: the caller records it.
 */
export function judgeWorldConfig(document: unknown, worldId: string, foundation: WorldFoundation | null): WorldConfigJudgement {
  return judge(document, worldId, foundation, (candidate) => collectionProblems(foundation!.collections, candidate))
}

/**
 * The verdict `judgedBy` gives, for checking a recorded verdict again: this build's judge, or
 * world-evolution-v2. Null for any other judge, whose rules this build does not have.
 */
export function judgeWorldConfigAs(judgedBy: string, document: unknown, worldId: string, foundation: WorldFoundation): WorldConfigJudgement | null {
  if (judgedBy === WORLD_CONFIG_JUDGE) return judgeWorldConfig(document, worldId, foundation)
  if (judgedBy === WORLD_CONFIG_JUDGE_V2) return judge(document, worldId, foundation, (candidate) => evolutionProblems(foundation, foundation.collections, candidate))
  return null
}

function judge(document: unknown, worldId: string, foundation: WorldFoundation | null, incompatible: (candidate: WorldFoundation) => ConfigProblem[]): WorldConfigJudgement {
  const parsed = parsePlayCityConfig(document, worldId)
  if (!parsed.ok) return { verdict: 'rejected', code: 'config_invalid', problems: parsed.problems }
  const compiled = compileBrandWorld(parsed.config)
  if (!compiled.ok) return { verdict: 'rejected', code: 'config_invalid', problems: compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })) }
  const candidate = foundationOf(parsed.config, compiled.world)
  if (foundation) {
    const problems = incompatible(candidate)
    if (problems.length > 0) return { verdict: 'rejected', code: 'config_incompatible', problems }
  }
  return { verdict: 'accepted', config: parsed.config, world: compiled.world, foundation: candidate }
}

/**
 * The collections a world has established: its foundation's, then those of every version that
 * has governed it (`governed`, in adoption order). A key keeps the first contract it named.
 */
export function establishedCollections(foundation: WorldFoundation, governed: readonly (readonly FoundationCollection[])[]): FoundationCollection[] {
  const out: FoundationCollection[] = []
  for (const c of [foundation.collections, ...governed].flat()) if (!out.some((x) => x.key === c.key)) out.push({ key: c.key, chain: c.chain, contract: c.contract })
  return out
}

/**
 * Why an ACCEPTED version (its foundation `candidate`) cannot govern a world that has established
 * `established` and whose geometry is `frozen` (null while it has no property). Empty when it can.
 */
export function governingProblems(established: readonly FoundationCollection[], candidate: WorldFoundation, frozen: WorldGeometry | null): ConfigProblem[] {
  const { problems, add } = collector()
  if (frozen) addGeometryProblems(frozen, candidate, 'first-property', add)
  addCollectionProblems(established, candidate, add)
  return problems
}
