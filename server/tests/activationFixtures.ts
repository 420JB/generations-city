import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { newBuilding } from '../../src/game/allocation'
import { plotId } from '../../src/game/world'
import { CITY_ID } from '../src/city/store'
import { districtForFamily, RARE_FRIENDS_CHAIN, type GameState } from '../src/engine'

/**
 * Rows for the activation schema, written the way the (not yet existing) activation
 * service will write them. TEST ONLY: nothing in the service creates a property.
 */
export const CHAIN_ID = RARE_FRIENDS_CHAIN.chainId
export const COLLECTION = RARE_FRIENDS_CHAIN.generations.toLowerCase()
export const ORIGIN = 'https://rarecity.example'
const T0 = new Date('2026-10-02T12:00:00.000Z')

export interface Identity {
  userId: string
  walletId: string
  sessionId: string
  address: string
}

/** A signed-in user: one user, one wallet, one live session. */
export async function addIdentity(db: pg.Pool): Promise<Identity> {
  const address = `0x${randomBytes(20).toString('hex')}`
  const userId = (await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
  const walletId = (await db.query<{ id: string }>('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, $2, $3) RETURNING id', [userId, CHAIN_ID, address])).rows[0].id
  const sessionId = (await db.query<{ id: string }>(`INSERT INTO sessions (token_hash, user_id, wallet_id, expires_at) VALUES ($1, $2, $3, now() + interval '7 days') RETURNING id`, [randomBytes(32), userId, walletId])).rows[0].id
  return { userId, walletId, sessionId, address }
}

export interface IntentInput {
  identity: Identity
  instance: string
  tokenId: number | string
  familyId: number
  ward: number
  plot: number
  id?: string
  /** Column overrides, for tests that insert a deliberately wrong row. */
  override?: Record<string, unknown>
}

/** The column values of an issued intent for this Friend and plot. */
export function intentColumns(input: IntentInput): Record<string, unknown> {
  const districtId = districtForFamily(input.familyId) ?? 'd4'
  return {
    id: input.id ?? randomBytes(32).toString('hex'),
    user_id: input.identity.userId,
    wallet_id: input.identity.walletId,
    session_id: input.identity.sessionId,
    owner_address: input.identity.address,
    chain_id: CHAIN_ID,
    collection: COLLECTION,
    token_id: String(input.tokenId),
    family_id: input.familyId,
    city_id: CITY_ID,
    city_instance_id: input.instance,
    district_id: districtId,
    ward: input.ward,
    plot: input.plot,
    plot_id: `${districtId}-w${input.ward}-p${input.plot}`,
    origin: ORIGIN,
    digest: randomBytes(32),
    issued_at: T0,
    expires_at: new Date(T0.getTime() + 600_000),
    issued_block: 79_000_000,
    ...input.override,
  }
}

export async function insertRow(db: pg.Pool | pg.PoolClient, table: string, columns: Record<string, unknown>): Promise<void> {
  const names = Object.keys(columns)
  await db.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(columns))
}

/** Insert an issued intent and return its id. */
export async function addIntent(db: pg.Pool | pg.PoolClient, input: IntentInput): Promise<string> {
  const columns = intentColumns(input)
  await insertRow(db, 'activation_intents', columns)
  return columns.id as string
}

export interface Activation {
  intentId: string
  propertyId: string
  eraId: string
  sequence: number
  buildingId: string
}

/** The column values of the property an intent authorises, at `sequence`. */
export function propertyColumns(intent: Record<string, unknown>, sequence: number, propertyId: string = randomUUID()): Record<string, unknown> {
  return {
    id: propertyId,
    city_id: intent.city_id,
    city_instance_id: intent.city_instance_id,
    chain_id: intent.chain_id,
    collection: intent.collection,
    token_id: intent.token_id,
    family_id: intent.family_id,
    district_id: intent.district_id,
    ward: intent.ward,
    plot: intent.plot,
    plot_id: intent.plot_id,
    building_id: `b-${String(intent.token_id)}`,
    activated_at: new Date(T0.getTime() + 60_000),
    activated_sequence: sequence,
    activated_by_user_id: intent.user_id,
    activated_by_wallet_id: intent.wallet_id,
    activation_intent_id: intent.id,
    verified_block: 79_000_100,
  }
}

/**
 * One whole activation, in the order the service will use: lock the city, add the
 * building to its state, advance the sequence, append the event, insert the property and
 * its first ownership era, then commit the intent. One transaction.
 */
export async function activate(db: pg.Pool, input: IntentInput, options: { failAt?: 'property' | 'era' | 'commit'; eraOwner?: Identity; era?: Record<string, unknown>; skip?: 'era' | 'commit' } = {}): Promise<Activation> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const intent = intentColumns(input)
    await insertRow(client, 'activation_intents', intent)
    const city = (await client.query<{ sequence: string; state: GameState }>('SELECT sequence, state FROM city WHERE id = $1 FOR UPDATE', [CITY_ID])).rows[0]
    const sequence = Number(city.sequence) + 1
    const friendId = Number(input.tokenId)
    const districtId = districtForFamily(input.familyId)!
    const state = city.state
    const building = newBuilding({ friendId, ownerId: input.identity.userId, address: { districtId, ward: input.ward, plot: input.plot }, clock: state.clock + 1 })
    state.clock += 1
    state.users[input.identity.userId] ??= { id: input.identity.userId, handle: `${input.identity.address.slice(0, 6)}…${input.identity.address.slice(-4)}`, friendId, hue: 200 }
    state.buildings[building.id] = building
    state.wards[districtId] = Math.max(state.wards[districtId], input.ward + 1)
    await client.query('UPDATE city SET state = $2::json, sequence = $3, updated_at = now() WHERE id = $1', [CITY_ID, JSON.stringify(state), sequence])
    await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, 'property.activated', $3::jsonb)`, [CITY_ID, sequence, JSON.stringify({ buildingId: building.id, plotId: plotId(districtId, input.ward, input.plot) })])

    const propertyId = randomUUID()
    if (options.failAt === 'property') throw new Error('injected failure before the property')
    await insertRow(client, 'properties', propertyColumns(intent, sequence, propertyId))
    const eraId = randomUUID()
    if (options.failAt === 'era') throw new Error('injected failure before the era')
    const owner = options.eraOwner ?? input.identity
    if (options.skip !== 'era')
      await insertRow(client, 'ownership_eras', { id: eraId, property_id: propertyId, era_number: 1, owner_address: owner.address, owner_wallet_id: owner.walletId, owner_user_id: owner.userId, started_at: new Date(T0.getTime() + 60_000), start_reason: 'activation', start_block: 79_000_100, ...options.era })
    if (options.failAt === 'commit') throw new Error('injected failure before the intent is committed')
    if (options.skip !== 'commit')
      await client.query(`UPDATE activation_intents SET status = 'committed', committed_at = $2, signature = $3, property_id = $4 WHERE id = $1`, [intent.id, new Date(T0.getTime() + 60_000), randomBytes(65), propertyId])
    await client.query('COMMIT')
    return { intentId: intent.id as string, propertyId, eraId, sequence, buildingId: building.id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/** Every row of a table as JSON text, for "nothing changed" assertions. */
export async function snapshot(db: pg.Pool, table: string, orderBy: string): Promise<string> {
  return JSON.stringify((await db.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`)).rows)
}

const GUARDED = ['app_meta', 'city', 'city_events', 'activation_intents', 'properties', 'ownership_eras', 'wallets', 'sessions']

/**
 * Run `work` with every guard trigger switched off, to put a database into a state the
 * guards make unreachable. That is how the application-level checks (the reset, city:verify)
 * and the tables' own constraints are tested in isolation. It needs table ownership, which
 * the test role has and a production service role must not.
 */
export async function unguarded<T>(db: pg.Pool, work: () => Promise<T>): Promise<T> {
  for (const table of GUARDED) await db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  try {
    return await work()
  } finally {
    for (const table of GUARDED) await db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
  }
}

/** Move the city one sequence forward with the event that explains it, as any authoritative change does. */
export async function advance(db: pg.Pool, type: string, state?: GameState): Promise<number> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const sequence = Number((await client.query<{ sequence: string }>('SELECT sequence FROM city WHERE id = $1 FOR UPDATE', [CITY_ID])).rows[0].sequence) + 1
    if (state) await client.query('UPDATE city SET sequence = $2, state = $3::json, updated_at = now() WHERE id = $1', [CITY_ID, sequence, JSON.stringify(state)])
    else await client.query('UPDATE city SET sequence = $2, updated_at = now() WHERE id = $1', [CITY_ID, sequence])
    await client.query('INSERT INTO city_events (city_id, sequence, type) VALUES ($1, $2, $3)', [CITY_ID, sequence, type])
    await client.query('COMMIT')
    return sequence
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
