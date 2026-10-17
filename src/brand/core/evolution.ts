import type { World } from '../../world/definition'
import { canonicalAddress, isPermanentKey, parseChainRef } from '../../world/identity'
import type { BrandCityConfig, ConfigProblem } from './config'
import { compileBrandWorld } from './layout'
import { parsePlayCityConfig } from './playConfig'

/**
 * HOW A PERSISTENT BRAND CITY'S CONFIGURATION MAY CHANGE.
 *
 * A world is founded on one accepted Proofy Play configuration version. What that version
 * fixed is its FOUNDATION, recorded once with the world and never changed:
 *   - the layout: its key and its geometry fingerprint, which covers every district's key and
 *     wedge (and so the district count and order), i.e. which plots every plot id names;
 *   - the collections: each collection key and the contract it names.
 *
 * Two questions are asked of every later version, and they are kept apart on purpose:
 *
 *   VERDICT (permanent, recorded once per version): is it a valid city on THIS foundation?
 *     It is ACCEPTED only if it keeps the foundation's geometry exactly, keeps every founding
 *     collection (same key, same chain and contract) and names no founding contract under
 *     another key. It is judged against the foundation alone, never against other versions,
 *     so it is the same whichever launch shows the version first: the order in which Play run
 *     tokens are redeemed cannot change any verdict. Anything else is REJECTED.
 *
 *   GOVERNING (asked on every launch, never recorded): may this accepted version govern the
 *     world NOW? Only if it also keeps every collection ESTABLISHED by the versions that have
 *     governed the world (its adoptions), with the same contract, and names none of their
 *     contracts under another key. Collections are additive: once a version that added one
 *     has governed, no version without it (an older one re-activated, or a new one) can
 *     govern, and a launch pinned to such a version is refused, not drawn.
 *
 * A version may change any presentation (names, accents, logo, crest, monuments, rule labels
 * and references) and may add collections. Nothing can ever move a plot or reassign what a
 * collection key means in the world's governing history.
 *
 * This is deliberately not a migration system: an incompatible configuration is refused,
 * never translated. Relaxing a rule later (for example, letting an empty world change its
 * districts) stays possible; tightening one after worlds have drifted would not be.
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

/** A stored foundation (exactly the shape `foundationOf` makes), or null. */
export function parseWorldFoundation(value: unknown): WorldFoundation | null {
  if (!isRecord(value) || !exactKeys(value, ['layout', 'districts', 'collections'])) return null
  const { layout, districts, collections } = value
  if (!isRecord(layout) || !exactKeys(layout, ['key', 'geometryFingerprint']) || !isPermanentKey(layout.key) || typeof layout.geometryFingerprint !== 'string' || !HEX64.test(layout.geometryFingerprint)) return null
  if (!Array.isArray(districts) || districts.length === 0 || !Array.isArray(collections) || collections.length === 0) return null
  const outDistricts: WorldFoundation['districts'] = []
  for (const d of districts) {
    if (!isRecord(d) || !exactKeys(d, ['key', 'geometryFingerprint']) || !isPermanentKey(d.key) || typeof d.geometryFingerprint !== 'string' || !HEX64.test(d.geometryFingerprint)) return null
    if (outDistricts.some((x) => x.key === d.key)) return null
    outDistricts.push({ key: d.key, geometryFingerprint: d.geometryFingerprint })
  }
  const outCollections: FoundationCollection[] = []
  for (const c of collections) {
    if (!isRecord(c) || !exactKeys(c, ['key', 'chain', 'contract']) || !isPermanentKey(c.key)) return null
    const chain = parseChainRef(c.chain)
    const contract = canonicalAddress(c.contract)
    if (!chain || !contract || contract !== c.contract) return null
    if (outCollections.some((x) => x.key === c.key)) return null
    outCollections.push({ key: c.key, chain: chain.text, contract })
  }
  return { layout: { key: layout.key, geometryFingerprint: layout.geometryFingerprint }, districts: outDistricts, collections: outCollections }
}

export function sameFoundation(a: WorldFoundation, b: WorldFoundation): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Why `candidate` is incompatible with a world founded on `foundation`, given the collections
 * it must keep (`known`, which includes the foundation's own): the founding collections for a
 * verdict, the established ones for governing. Empty when it is compatible.
 */
export function evolutionProblems(foundation: WorldFoundation, known: readonly FoundationCollection[], candidate: WorldFoundation): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  const add = (path: string, detail: string) => problems.length < 50 && problems.push({ path, detail })

  if (candidate.layout.key !== foundation.layout.key || candidate.layout.geometryFingerprint !== foundation.layout.geometryFingerprint) {
    const before = new Map(foundation.districts.map((d, i) => [d.key, { ...d, index: i }]))
    const after = new Map(candidate.districts.map((d, i) => [d.key, { ...d, index: i }]))
    if (candidate.layout.key !== foundation.layout.key) add('layout', `the city was founded on layout ${foundation.layout.key}; it cannot change`)
    if (candidate.districts.length !== foundation.districts.length) add('districts', `the city was founded with ${foundation.districts.length} districts; their number cannot change`)
    for (const key of before.keys()) if (!after.has(key)) add('districts',`district ${key} is part of this city and cannot be removed or renamed (its name can change; its key cannot)`)
    for (const [key, d] of after) {
      const was = before.get(key)
      if (!was) add(`districts[${d.index}].key`, `district ${key} is not one of this city's districts; districts cannot be added`)
      else if (was.geometryFingerprint !== d.geometryFingerprint) add(`districts[${d.index}]`, `district ${key} would move (it stood at position ${was.index + 1}); district positions are fixed when the city is founded`)
    }
    if (problems.length === 0) add('districts', 'the city\'s district geometry would change; it is fixed when the city is founded')
  }

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
  return problems
}

/** What a world (or a world about to be founded) makes of a Play configuration document. */
export type WorldConfigJudgement =
  | { verdict: 'accepted'; config: Readonly<BrandCityConfig>; world: World; foundation: WorldFoundation }
  | { verdict: 'rejected'; code: 'config_invalid' | 'config_incompatible'; problems: ConfigProblem[] }

/** Names this judgement in `world_config_versions.judged_by`. A change to any rule here is a new name. */
export const WORLD_CONFIG_JUDGE = 'rare-city/play-config-v1+world-evolution-v2'

/**
 * Judge a Play configuration document (schema version 1) for the world `worldId`.
 * `foundation` is the world's foundation, or null when the document would found the world.
 * The verdict depends on the document and the foundation alone (see above). Pure: the caller
 * records it.
 */
export function judgeWorldConfig(document: unknown, worldId: string, foundation: WorldFoundation | null): WorldConfigJudgement {
  const parsed = parsePlayCityConfig(document, worldId)
  if (!parsed.ok) return { verdict: 'rejected', code: 'config_invalid', problems: parsed.problems }
  const compiled = compileBrandWorld(parsed.config)
  if (!compiled.ok) return { verdict: 'rejected', code: 'config_invalid', problems: compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })) }
  const candidate = foundationOf(parsed.config, compiled.world)
  if (foundation) {
    const problems = evolutionProblems(foundation, foundation.collections, candidate)
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
 * Why an ACCEPTED version (its foundation `candidate`) cannot govern a world founded on
 * `foundation` that has established `established`. Empty when it can.
 */
export function governingProblems(foundation: WorldFoundation, established: readonly FoundationCollection[], candidate: WorldFoundation): ConfigProblem[] {
  return evolutionProblems(foundation, established, candidate)
}
