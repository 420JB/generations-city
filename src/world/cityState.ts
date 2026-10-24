import { parseAssetKey } from './asset'
import { isPermanentKey } from './identity'

/**
 * THE STORED STATE OF A WORLD'S CITY: what `city.state` holds for the city of a world (a
 * `worlds` row, migration 0005). Two versions, and each spells exactly one kind of city, so a
 * later state model is a new version an older build refuses to read, never one it misreads.
 *
 * VERSION 1, AS FOUNDED. A world's city is founded empty: no residents, no buildings, no
 * progress, nothing simulated.
 *   buildings  `{}`. The 0004 city guard requires it at install for any city that may hold
 *              properties.
 *   openWards  `{}`: every district has only its founding ward open.
 *
 * VERSION 2, WITH PROPERTIES. The city a world's city becomes with its first property
 * (migration 0007). It holds exactly what the property records hold, and nothing they do not:
 *   buildings  one per property, keyed by its building id (`b-<property id>`, the
 *              `property-v1` scheme), in the order they were activated. Each names its NFT
 *              (CAIP-19), the collection key it was activated under, its exact plot and the
 *              city sequence that activated it. No progress, owner, architecture, economy or
 *              time: none of those is recorded anywhere yet, so none is stored here.
 *   openWards  per district key, how many wards are open, written only for a district with
 *              MORE than its founding ward open. A ward opens only when a property is placed in
 *              it (`choosePlot`), so this always equals one more than the district's highest
 *              occupied ward.
 * A version 2 city has at least one building: an empty city is version 1, so every state has
 * one spelling. Whether the buildings and wards fit the world's layout is the engine's question
 * (`worldCityProblems`); this module reads shape only.
 *
 * VERSION 3, WITH CONSTRUCTION (P1-C2-E3A, migration 0013). The city a world's city becomes with
 * its first construction action, and stays: exactly version 2 (buildings and openWards unchanged,
 * a building's `sequence` still the activation's), plus
 *   development  per building that has been built on, keyed by its building id and in the order
 *                of `buildings`: its tier, the lifetime construction units built into it, and the
 *                city sequence of its latest construction. A building with nothing built has no
 *                entry, so the map is never empty and every state has one spelling. Who built and
 *                what they spent are the construction records' (`world_property_constructions`),
 *                not the state's.
 * In versions 2 and 3 every city sequence after the first is either one activation or one
 * construction (`construction.ts`), so building sequences increase but may skip.
 *
 * The legacy Rare Friends city (`main`) keeps its own `GameState` (state version 5). The two
 * never meet: a city row is a world's only when a `worlds` row names it.
 */
export const WORLD_CITY_STATE_VERSION = 1
/** The state version of a world's city once it holds a property. */
export const POPULATED_WORLD_CITY_STATE_VERSION = 2

export interface EmptyWorldCityState {
  version: typeof WORLD_CITY_STATE_VERSION
  buildings: Record<string, never>
  openWards: Record<string, never>
}

/** A property's building, exactly as `city.state` stores it. */
export interface WorldBuildingRecord {
  /** V2 property id (`property.ts`). The building's key is `b-<propertyId>`. */
  propertyId: string
  /** CAIP-19 key of the NFT (`assetKey`). */
  asset: string
  /** Key of the world collection the NFT was activated under. */
  collection: string
  districtKey: string
  ward: number
  plot: number
  /** The city sequence the activation produced (2 or more). */
  sequence: number
}

export interface PopulatedWorldCityState {
  version: typeof POPULATED_WORLD_CITY_STATE_VERSION
  buildings: Record<string, WorldBuildingRecord>
  /** Districts with more than their founding ward open. */
  openWards: Record<string, number>
}

/** The state version of a world's city once anything has been built in it (migration 0013). */
export const CONSTRUCTED_WORLD_CITY_STATE_VERSION = 3

/** What has been built into one building, exactly as `city.state.development` stores it. */
export interface WorldBuildingDevelopment {
  /** The building's tier, as the construction recipe derives it from `built`. */
  tier: number
  /** Lifetime construction units built into it (1 or more): every contributor, every era. */
  built: number
  /** The city sequence of its latest construction (after its activation's). */
  sequence: number
}

export interface ConstructedWorldCityState {
  version: typeof CONSTRUCTED_WORLD_CITY_STATE_VERSION
  buildings: Record<string, WorldBuildingRecord>
  openWards: Record<string, number>
  /** Buildings with anything built, in the order of `buildings`. Never empty. */
  development: Record<string, WorldBuildingDevelopment>
}

export type WorldCityState = EmptyWorldCityState | PopulatedWorldCityState | ConstructedWorldCityState

/** A state that holds properties (version 2 or 3). */
export type PropertiedWorldCityState = PopulatedWorldCityState | ConstructedWorldCityState

/** The state a world's city is founded with. A fresh object every call, in a fixed key order. */
export function emptyWorldCityState(): EmptyWorldCityState {
  return { version: WORLD_CITY_STATE_VERSION, buildings: {}, openWards: {} }
}

/** The building key of a property in a world's state. */
export const worldBuildingId = (propertyId: string) => `b-${propertyId}`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isEmptyRecord = (v: unknown): v is Record<string, never> => isRecord(v) && Object.keys(v).length === 0
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Ward and plot indices a plot id can spell (`plots.ts`). */
const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 1_000_000
const BUILDING_KEYS = ['propertyId', 'asset', 'collection', 'districtKey', 'ward', 'plot', 'sequence'] as const

function parseBuilding(key: string, v: unknown): WorldBuildingRecord | null {
  if (!isRecord(v) || !exactKeys(v, BUILDING_KEYS)) return null
  const { propertyId, asset, collection, districtKey, ward, plot, sequence } = v
  if (typeof propertyId !== 'string' || !UUID.test(propertyId) || key !== worldBuildingId(propertyId)) return null
  if (!parseAssetKey(asset) || !isPermanentKey(collection) || !isPermanentKey(districtKey) || !isIndex(ward) || !isIndex(plot)) return null
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 2) return null
  return { propertyId, asset: asset as string, collection, districtKey, ward, plot, sequence: sequence as number }
}

/** Construction units a building can record: far beyond any recipe, well inside a safe integer and Postgres `integer`. */
const MAX_BUILT = 1_000_000_000
const MAX_TIER = 64
const DEVELOPMENT_KEYS = ['tier', 'built', 'sequence'] as const

function parseDevelopment(v: unknown, building: WorldBuildingRecord): WorldBuildingDevelopment | null {
  if (!isRecord(v) || !exactKeys(v, DEVELOPMENT_KEYS)) return null
  const { tier, built, sequence } = v
  if (!Number.isSafeInteger(tier) || (tier as number) < 0 || (tier as number) > MAX_TIER) return null
  if (!Number.isSafeInteger(built) || (built as number) < 1 || (built as number) > MAX_BUILT) return null
  if (!Number.isSafeInteger(sequence) || (sequence as number) <= building.sequence) return null
  return { tier: tier as number, built: built as number, sequence: sequence as number }
}

/**
 * A stored world city state this build can read, or null: version 1 exactly as founded,
 * version 2 with at least one building, or version 3 with at least one developed building,
 * exactly these keys and each value in its grammar. Anything else is refused rather than drawn
 * in part. Returns a fresh copy in the stored order.
 */
export function parseWorldCityState(value: unknown): WorldCityState | null {
  if (isRecord(value) && value.version === CONSTRUCTED_WORLD_CITY_STATE_VERSION) return parseConstructed(value)
  if (!isRecord(value) || !exactKeys(value, ['version', 'buildings', 'openWards'])) return null
  if (value.version === WORLD_CITY_STATE_VERSION) return isEmptyRecord(value.buildings) && isEmptyRecord(value.openWards) ? emptyWorldCityState() : null
  if (value.version !== POPULATED_WORLD_CITY_STATE_VERSION) return null
  return parsePopulated(value)
}

function parsePopulated(value: Record<string, unknown>): PopulatedWorldCityState | null {
  if (!isRecord(value.buildings) || !isRecord(value.openWards)) return null
  const entries = Object.entries(value.buildings)
  if (entries.length === 0) return null
  const buildings: Record<string, WorldBuildingRecord> = {}
  for (const [key, raw] of entries) {
    const b = parseBuilding(key, raw)
    if (!b) return null
    buildings[key] = b
  }
  const openWards: Record<string, number> = {}
  for (const [key, open] of Object.entries(value.openWards)) {
    if (!isPermanentKey(key) || !Number.isSafeInteger(open) || (open as number) < 2 || (open as number) > 1_000_000) return null
    openWards[key] = open as number
  }
  return { version: POPULATED_WORLD_CITY_STATE_VERSION, buildings, openWards }
}

/** Version 3: version 2's buildings and wards, and a non-empty development map over them, in their order. */
function parseConstructed(value: Record<string, unknown>): ConstructedWorldCityState | null {
  if (!exactKeys(value, ['version', 'buildings', 'openWards', 'development']) || !isRecord(value.development)) return null
  const populated = parsePopulated(value)
  if (!populated) return null
  const entries = Object.entries(value.development)
  if (entries.length === 0) return null
  const order = Object.keys(populated.buildings)
  const development: Record<string, WorldBuildingDevelopment> = {}
  let last = -1
  for (const [key, raw] of entries) {
    const at = order.indexOf(key)
    if (at <= last) return null
    last = at
    const d = parseDevelopment(raw, populated.buildings[key])
    if (!d) return null
    development[key] = d
  }
  return { version: CONSTRUCTED_WORLD_CITY_STATE_VERSION, buildings: populated.buildings, openWards: populated.openWards, development }
}

/** The stored text of a state, exactly as `city.state` (json) keeps it. Two equal states have one text. */
export function worldCityStateText(state: WorldCityState): string {
  return JSON.stringify(state)
}
