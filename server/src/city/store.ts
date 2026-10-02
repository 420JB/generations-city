import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { isCityStateShape, type CityMeta, type CityOrigin, type GameState } from '../engine'

/** Rare City is one city. The id leaves room for another without a schema change. */
export const CITY_ID = 'main'

export interface CityRecord {
  meta: CityMeta
  /** Exactly what is stored. It is untyped until a caller has validated it. */
  state: unknown
}

/** READ side of the city, as the HTTP layer sees it. */
export interface CityReader {
  /** The city's identity and sequence without its state. null = no city installed. */
  meta(): Promise<CityMeta | null>
  /** One consistent row: the state and the sequence it belongs to. null = no city installed. */
  read(): Promise<CityRecord | null>
}

export type CityInitFailure = 'already-initialized' | 'wrong-environment' | 'fixture-in-production' | 'invalid-state'

export class CityInitError extends Error {
  readonly reason: CityInitFailure
  constructor(reason: CityInitFailure, message: string) {
    super(message)
    this.name = 'CityInitError'
    this.reason = reason
  }
}

interface MetaRow {
  id: string
  instance_id: string
  sequence: string
  state_version: number
  canonical: boolean
  origin: CityOrigin
  updated_at: Date
}

const META_COLUMNS = 'id, instance_id, sequence, state_version, canonical, origin, updated_at'

function toMeta(row: MetaRow): CityMeta {
  // bigint arrives as text; the sequence stays far inside the safe integer range.
  const sequence = Number(row.sequence)
  if (!Number.isSafeInteger(sequence)) throw new Error('city sequence is out of range')
  return { id: row.id, instance: row.instance_id, sequence, stateVersion: row.state_version, canonical: row.canonical, origin: row.origin, updatedAt: row.updated_at.toISOString() }
}

export function createCityReader(db: Database): CityReader {
  return {
    async meta() {
      const { rows } = await db.query<MetaRow>(`SELECT ${META_COLUMNS} FROM city WHERE id = $1`, [CITY_ID])
      return rows[0] ? toMeta(rows[0]) : null
    },
    async read() {
      const { rows } = await db.query<MetaRow & { state: unknown }>(`SELECT ${META_COLUMNS}, state FROM city WHERE id = $1`, [CITY_ID])
      return rows[0] ? { meta: toMeta(rows[0]), state: rows[0].state } : null
    },
  }
}

/**
 * Install the city at sequence 1. This is the only way a city comes to exist.
 *
 * One transaction: the city row and its first event appear together or not at all. It
 * refuses a database stamped for another environment, refuses a non-canonical origin in
 * production, and refuses once a city exists (it never overwrites one).
 */
export async function initializeCity(db: Database, options: { state: GameState; origin: CityOrigin; environment: AppMode }): Promise<CityMeta> {
  const { state, origin, environment } = options
  const canonical = origin === 'genesis'
  if (!canonical && environment === 'production') throw new CityInitError('fixture-in-production', 'A non-canonical city cannot be installed when APP_MODE=production.')
  if (!isCityStateShape(state)) throw new CityInitError('invalid-state', 'The state to install is not a valid city state.')

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const stamp = (await client.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows[0]?.value
    if (stamp !== environment) throw new CityInitError('wrong-environment', `This database belongs to the "${stamp ?? 'unstamped'}" environment; refusing to install a city as "${environment}".`)

    // ON CONFLICT serialises concurrent installers: the loser sees no row returned.
    const inserted = await client.query<MetaRow>(
      `INSERT INTO city (id, canonical, origin, state_version, sequence, state)
       VALUES ($1, $2, $3, $4, 1, $5::json)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${META_COLUMNS}`,
      [CITY_ID, canonical, origin, state.version, JSON.stringify(state)],
    )
    if (!inserted.rows[0]) throw new CityInitError('already-initialized', 'This database already has a city; it will not be overwritten.')
    await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, 1, 'city.initialized', $2::jsonb)`, [
      CITY_ID,
      JSON.stringify({ origin, canonical, stateVersion: state.version, environment }),
    ])
    await client.query('COMMIT')
    return toMeta(inserted.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
