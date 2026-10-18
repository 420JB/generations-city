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

export type WorldCityState = EmptyWorldCityState | PopulatedWorldCityState

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

/**
 * A stored world city state this build can read, or null: version 1 exactly as founded, or
 * version 2 with at least one building, exactly these keys and each value in its grammar.
 * Anything else is refused rather than drawn in part. Returns a fresh copy in the stored order.
 */
export function parseWorldCityState(value: unknown): WorldCityState | null {
  if (!isRecord(value) || !exactKeys(value, ['version', 'buildings', 'openWards'])) return null
  if (value.version === WORLD_CITY_STATE_VERSION) return isEmptyRecord(value.buildings) && isEmptyRecord(value.openWards) ? emptyWorldCityState() : null
  if (value.version !== POPULATED_WORLD_CITY_STATE_VERSION || !isRecord(value.buildings) || !isRecord(value.openWards)) return null
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

/** The stored text of a state, exactly as `city.state` (json) keeps it. Two equal states have one text. */
export function worldCityStateText(state: WorldCityState): string {
  return JSON.stringify(state)
}
