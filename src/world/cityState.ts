/**
 * THE STORED STATE OF A WORLD'S CITY, version 1: what `city.state` holds for the city of a
 * world (a `worlds` row, migration 0005).
 *
 * A world's city is founded empty and stays empty until claims exist: no residents, no
 * buildings, no progress, nothing simulated. Version 1 can say exactly that and nothing more,
 * so a later state model is a new version this build refuses to read, never one it misreads.
 *
 *   buildings  `{}`. The 0004 city guard requires it at install for any city that may hold
 *              properties, and this version holds none.
 *   openWards  `{}`. Open wards per district key; a district absent here has only its founding
 *              ward open (`WorldOccupancy`), which is every district of an empty city.
 *
 * The legacy Rare Friends city (`main`) keeps its own `GameState` (state version 5). The two
 * never meet: a city row is a world's only when a `worlds` row names it.
 */
export const WORLD_CITY_STATE_VERSION = 1

export interface WorldCityState {
  version: typeof WORLD_CITY_STATE_VERSION
  buildings: Record<string, never>
  openWards: Record<string, never>
}

/** The state a world's city is founded with. A fresh object every call, in a fixed key order. */
export function emptyWorldCityState(): WorldCityState {
  return { version: WORLD_CITY_STATE_VERSION, buildings: {}, openWards: {} }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isEmptyRecord = (v: unknown): v is Record<string, never> => isRecord(v) && Object.keys(v).length === 0

/**
 * A stored world city state this build can read, or null. Exactly these keys, and empty: a
 * state with a building, an opened ward or anything unknown is not one this build supports,
 * and is refused rather than drawn in part.
 */
export function parseWorldCityState(value: unknown): WorldCityState | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 3 || !keys.includes('version') || !keys.includes('buildings') || !keys.includes('openWards')) return null
  if (value.version !== WORLD_CITY_STATE_VERSION || !isEmptyRecord(value.buildings) || !isEmptyRecord(value.openWards)) return null
  return emptyWorldCityState()
}
