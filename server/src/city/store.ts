import type { PoolClient } from 'pg'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { checkAuthoritativeCity, isCityStateShape, type CityMeta, type CityOrigin, type GameState, type Violation } from '../engine'

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

export type CityInitFailure = 'already-initialized' | 'wrong-environment' | 'fixture-in-production' | 'canonical-outside-production' | 'invalid-state'

export class CityInitError extends Error {
  readonly reason: CityInitFailure
  /** For `invalid-state`: what the deep check found. */
  readonly violations: Violation[]
  constructor(reason: CityInitFailure, message: string, violations: Violation[] = []) {
    super(message)
    this.name = 'CityInitError'
    this.reason = reason
    this.violations = violations
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

export interface CityInstall {
  state: GameState
  origin: CityOrigin
  /** true = a disposable activation rehearsal. Only ever with the non-canonical origin. */
  rehearsal?: boolean
  environment: AppMode
  /** Extra facts for the `city.initialized` event, for an install that replaces a disposable city. */
  eventExtra?: Record<string, unknown>
}

/**
 * Refuse, before any database work, an install this environment may never hold or whose
 * state is not one an authority may hold. A city that may hold real properties must start
 * with none, so its state must have no buildings at all.
 */
export function assertInstallable({ state, origin, rehearsal = false, environment }: CityInstall): void {
  const canonical = origin === 'genesis'
  if (!canonical && environment === 'production') throw new CityInitError('fixture-in-production', 'A non-canonical city cannot be installed when APP_MODE=production.')
  if (canonical && environment !== 'production') throw new CityInitError('canonical-outside-production', `A canonical city can only be installed when APP_MODE=production, not ${environment}.`)
  if (!isCityStateShape(state)) throw new CityInitError('invalid-state', 'The state to install is not a valid city state.')
  const check = checkAuthoritativeCity({ flags: { canonical, origin, activationRehearsal: rehearsal }, state, properties: [] })
  if (check.mode === null || check.violations.length > 0) throw new CityInitError('invalid-state', `The state to install fails ${check.violations.length} authoritative invariant(s): ${check.violations[0]?.detail ?? 'unknown city mode'}.`, check.violations)
}

/**
 * Insert the city at sequence 1 with its first event, on a connection that is already in
 * a transaction. Returns null when a city already exists (nothing is written).
 */
export async function insertCity(client: PoolClient, install: CityInstall): Promise<CityMeta | null> {
  const { state, origin, rehearsal = false, environment, eventExtra = {} } = install
  const canonical = origin === 'genesis'
  // The rehearsal column is named only when it is set: an ordinary install is the same statement it has always
  // been, and the column's default (false) applies. ON CONFLICT serialises concurrent installers: the loser
  // sees no row returned.
  const inserted = await client.query<MetaRow>(
    `INSERT INTO city (id, canonical, origin, state_version, sequence, state${rehearsal ? ', activation_rehearsal' : ''})
     VALUES ($1, $2, $3, $4, 1, $5::json${rehearsal ? ', true' : ''})
     ON CONFLICT (id) DO NOTHING
     RETURNING ${META_COLUMNS}`,
    [CITY_ID, canonical, origin, state.version, JSON.stringify(state)],
  )
  if (!inserted.rows[0]) return null
  await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, 1, 'city.initialized', $2::jsonb)`, [
    CITY_ID,
    JSON.stringify({ origin, canonical, stateVersion: state.version, environment, ...(rehearsal ? { activationRehearsal: true } : {}), ...eventExtra }),
  ])
  return toMeta(inserted.rows[0])
}

/** The environment this database is stamped for, read on the given connection. */
export async function environmentStamp(client: PoolClient): Promise<string | undefined> {
  return (await client.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows[0]?.value
}

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
 * Install the city at sequence 1. Apart from the guarded staging reset (`city/genesis.ts`),
 * this is the only way a city comes to exist. Nothing calls it from a request, a deploy
 * or start-up: only the operator commands do.
 *
 * One transaction: the city row and its first event appear together or not at all. It
 * refuses a database stamped for another environment, refuses a non-canonical city in
 * production and a canonical one anywhere else, refuses a state that fails the
 * authoritative invariants, and refuses once a city exists (it never overwrites one).
 */
export async function initializeCity(db: Database, options: CityInstall): Promise<CityMeta> {
  assertInstallable(options)
  const { environment } = options

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const stamp = await environmentStamp(client)
    if (stamp !== environment) throw new CityInitError('wrong-environment', `This database belongs to the "${stamp ?? 'unstamped'}" environment; refusing to install a city as "${environment}".`)

    const meta = await insertCity(client, options)
    if (!meta) throw new CityInitError('already-initialized', 'This database already has a city; it will not be overwritten.')
    await client.query('COMMIT')
    return meta
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
