import pg, { type PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import {
  assetKey,
  nftAsset,
  POPULATED_WORLD_CITY_STATE_VERSION,
  PROPERTY_ACTIVATED_EVENT,
  proposePropertyActivation,
  worldCityStateText,
  worldProperty,
  type PropertyActivationRefusal,
  type PropertyTransition,
} from '../engine'
import type { Logger } from '../log'
import type { ExpectedActor, LivePlaySession, PlaySessionService } from '../play/session'
import { lockWorldForChange, WorldRefusal } from './store'

/**
 * WORLD PROPERTY ACTIVATION, AUTHORITATIVE PERSISTENCE (P1-C2-B2A). LOCAL ONLY.
 *
 * The one caller outside tests is the LOCAL PROPERTY REHEARSAL (`rehearsal.ts`, P1-C2-B2B), whose
 * route exists only in a local deployment started with an explicit rehearsal file (a test pins
 * that nothing else in server/src reaches this module). It refuses to run against any database but
 * a LOCAL one, as the database itself does (migration 0007). It exists so that the authoritative
 * write path of a property activation can be built, proven durable and rehearsed end to end before
 * any real player can reach it. Live player mutations stay on HOLD until, at least:
 *   F5  a browser-bound launch contract with Core/Play;
 *   F7  authoritative membership and entitlement revalidation;
 *   F3  authoritative Play game status;
 *   a fresh Core NFT / role / verification eligibility check before any permanent claim;
 * none of which exists. Nothing here checks that the player holds the NFT or meets a district's
 * Proofy rule, because no contract can say so: that is precisely why this is not a route.
 *
 * Steps, each of which the engine keeps pure (`src/world/gameplay.ts`):
 *   discover / validate / propose   the engine, on the city exactly as stored, under its lock;
 *   persist                         here: one transaction that advances the city one sequence,
 *                                   appends its `world.property.activated` event and writes the
 *                                   property, or writes nothing.
 *
 * Who may act: `createPropertyActivationService` takes the browser's cookie and the session,
 * world and player the page drew, and goes through `requireActor` (a fresh Play check, no cache,
 * no grace) before the store is asked. The store itself takes only a `LivePlaySession`, and the
 * database refuses a property whose session is not live and of this world.
 *
 * Idempotency: a property's id is derived from (world, NFT), so the same NFT can never be placed
 * twice. The same player repeating an activation that already happened (same NFT, same plot)
 * changes nothing and is answered with the property as it was (`fresh: false`). Anyone else gets
 * the refusal `asset-already-placed` and learns nothing about who placed it or in which session; so
 * does the same NFT on another plot. "The same player" is the Discord user of the session that
 * activated the property, while that session's row is still kept (`play_sessions`, 30 days after it
 * ends): no permanent activator identity is stored on a property yet (locked policy, not implemented), so once
 * the row is gone nobody can prove they were the activator and everyone is refused.
 *
 * The session is locked (FOR SHARE) right after the city, and must be live then: a sign-out, a
 * newer launch or Play ending the session either came first and the activation is refused
 * (`session_ended`), or waits until it commits. If the session expires between that check and the
 * database's own (`world_properties_guard`), the database's refusal is answered the same way.
 * Concurrent activations queue on the city's row lock, and each is judged on the city as the one
 * before it left it: two on one plot give one property and one `plot-unavailable`.
 */
export type WorldPropertyRefusalCode =
  | PropertyActivationRefusal
  /** This deployment does not write world properties (anything but a local database). */
  | 'mutations_held'
  /** The world could not be read as one this build wrote, or its storage failed. */
  | 'world_unavailable'
  /** The city moved while this activation was being written (should not happen under its lock). */
  | 'sequence_conflict'
  /** The play session ended (signed out, replaced, expired, or ended by Play) before the activation could be written. Nothing was. */
  | 'session_ended'
  /** The plot's district has a Proofy rule, and no contract can say whether the player meets it (only with `refuseRuleGatedDistricts`). */
  | 'district-rule-unverified'

export class WorldPropertyRefusal extends Error {
  readonly code: WorldPropertyRefusalCode
  constructor(code: WorldPropertyRefusalCode, message: string = code) {
    super(message)
    this.name = 'WorldPropertyRefusal'
    this.code = code
  }
}

/** What an activation names: an NFT, as untyped input, and the exact plot the player chose. */
export interface PropertyActivationInput {
  asset: { chain: unknown; contract: unknown; tokenId: unknown; standard?: unknown }
  plotId: unknown
}

/** A property as stored. */
export interface WorldPropertyRecord {
  id: string
  worldId: string
  buildingId: string
  asset: string
  collection: string
  plotId: string
  districtKey: string
  ward: number
  plot: number
  districtGeometryFingerprint: string
  sequence: number
  /** The adoption that governed the world when the property was activated, and its configuration version. */
  adoption: number
  configVersion: number
  sessionRef: string
  activatedAt: string
}

export interface PropertyActivationResult {
  /** false when the same NFT already stood on the same plot: nothing was written. */
  fresh: boolean
  property: WorldPropertyRecord
  /** The city's sequence after this call. */
  sequence: number
  /** Present when `fresh`: the engine's transition that was written. */
  transition?: PropertyTransition
}

/** Points inside the write at which a test may make it fail, or act, to prove nothing is left half-written. `locked`: the city is locked, the session not yet. */
export type ActivationStep = 'locked' | 'city' | 'event' | 'property'

export interface ActivationOptions {
  /**
   * Refuse a plot in a district that has a Proofy rule (`district-rule-unverified`), judged on the configuration that
   * governs the world under its lock. No contract can tell whether a player meets a rule, so a caller that cannot
   * verify it must not place anything there.
   */
  refuseRuleGatedDistricts?: boolean
}

export interface WorldPropertyStore {
  /** Activate a property for a session `requireActor` returned. LOCAL ONLY: see the top of this file. */
  activate(actor: LivePlaySession, input: PropertyActivationInput, options?: ActivationOptions): Promise<PropertyActivationResult>
}

export interface WorldPropertyStoreOptions {
  mode: AppMode
  log: Logger
  onStep?: (step: ActivationStep) => void | Promise<void>
}

/** What `world_properties_guard` (0007) raises when the session is not live and of the world. Migrations never change, so neither does this text. */
const GUARD_SESSION_NOT_LIVE = 'a world property is activated only in a live play session of its world'
/** PL/pgSQL `RAISE EXCEPTION` without an ERRCODE. */
const RAISE_EXCEPTION = 'P0001'

const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '8s'
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

interface StoredPropertyRow {
  id: string
  world_id: string
  chain: string
  standard: string
  contract: string
  token_id: string
  collection_key: string
  district_key: string
  ward: number
  plot: number
  plot_id: string
  building_id: string
  district_geometry_fingerprint: string
  activated_sequence: string
  activated_adoption_seq: number
  activated_config_version: number
  activated_in_play_session: string
  activated_at: Date
}

const recordOf = (r: StoredPropertyRow): WorldPropertyRecord => ({
  id: r.id,
  worldId: r.world_id,
  buildingId: r.building_id,
  asset: `${r.chain}/${r.standard}:${r.contract}/${r.token_id}`,
  collection: r.collection_key,
  plotId: r.plot_id,
  districtKey: r.district_key,
  ward: r.ward,
  plot: r.plot,
  districtGeometryFingerprint: r.district_geometry_fingerprint,
  sequence: Number(r.activated_sequence),
  adoption: r.activated_adoption_seq,
  configVersion: r.activated_config_version,
  sessionRef: r.activated_in_play_session,
  activatedAt: r.activated_at.toISOString(),
})

const PROPERTY_COLUMNS =
  'id, world_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id, district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version, activated_in_play_session, activated_at'

/** Every property of a world, in activation order. Read only; for verification and tests. */
export async function worldPropertiesOf(client: Pick<PoolClient, 'query'>, worldId: string): Promise<WorldPropertyRecord[]> {
  return (await client.query<StoredPropertyRow>(`SELECT ${PROPERTY_COLUMNS} FROM world_properties WHERE world_id = $1 ORDER BY activated_sequence`, [worldId])).rows.map(recordOf)
}

export function createWorldPropertyStore(db: Database, { mode, log, onStep }: WorldPropertyStoreOptions): WorldPropertyStore {
  const isRefusal = (err: unknown) => err instanceof WorldPropertyRefusal || err instanceof WorldRefusal

  return {
    async activate(actor, input, options = {}) {
      // The service's own hold, before anything is read. The database holds the same line (0007).
      if (mode !== 'local') throw new WorldPropertyRefusal('mutations_held', 'World properties are written only in a local database until live player mutations are authorized.')
      const asset = nftAsset(input.asset)
      if (!asset) throw new WorldPropertyRefusal('invalid-asset')
      if (typeof input.plotId !== 'string') throw new WorldPropertyRefusal('unknown-plot')
      const plotId = input.plotId

      let result: PropertyActivationResult
      try {
        result = await withTransaction(db, isRefusal, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
          await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
          await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
          const stamp = await environmentStamp(client)
          if (stamp !== 'local') throw new WorldPropertyRefusal('mutations_held', `the database is stamped "${stamp ?? 'unstamped'}"; world properties are written only in a local database`)

          // The world exactly as the session names it, read as every read is (binding, founding record, governing
          // version, state and property parity), its city locked FOR UPDATE: every change to the city queues here.
          const read = await lockWorldForChange(client, actor.scope)
          await onStep?.('locked')
          // The session, locked until this transaction ends (as the database's guard locks it): whatever ends it either
          // came first and is seen here, or waits for this activation to commit.
          const live = await client.query('SELECT 1 FROM play_sessions WHERE id = $1 AND world_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE', [actor.id, actor.scope.worldId])
          if (live.rowCount !== 1) throw new WorldPropertyRefusal('session_ended', 'The play session ended before the activation was written.')

          const property = worldProperty(read.world, asset)
          if (!property) throw new WorldPropertyRefusal('asset-not-in-world')

          // Idempotent for the player who activated it, and only for them: anyone else learns only that the NFT is placed.
          const existing = (await client.query<StoredPropertyRow>(`SELECT ${PROPERTY_COLUMNS} FROM world_properties WHERE id = $1`, [property.propertyId])).rows[0]
          if (existing) {
            if (existing.world_id !== actor.scope.worldId || existing.plot_id !== plotId) throw new WorldPropertyRefusal('asset-already-placed')
            const activator = (await client.query<{ discord_user_id: string }>('SELECT discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2', [existing.activated_in_play_session, actor.scope.worldId])).rows[0]
            if (activator?.discord_user_id !== actor.player.discordUserId) throw new WorldPropertyRefusal('asset-already-placed')
            return { fresh: false, property: recordOf(existing), sequence: read.sequence }
          }

          const proposed = proposePropertyActivation(read.world, read.state, read.sequence, { asset, plotId })
          if (!proposed.ok) throw new WorldPropertyRefusal(proposed.reason)
          const t = proposed.transition
          if (options.refuseRuleGatedDistricts && read.config.districts.find((d) => d.key === t.plot.districtKey)?.gate) throw new WorldPropertyRefusal('district-rule-unverified')

          const moved = await client.query(
            'UPDATE city SET state = $1::json, state_version = $2, sequence = $3, updated_at = now() WHERE id = $4 AND instance_id = $5 AND sequence = $6',
            [worldCityStateText(t.state), POPULATED_WORLD_CITY_STATE_VERSION, t.to, read.cityId, read.instance, t.from],
          )
          if (moved.rowCount !== 1) throw new WorldPropertyRefusal('sequence_conflict')
          await onStep?.('city')
          await client.query('INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, $3, $4::jsonb)', [read.cityId, t.to, PROPERTY_ACTIVATED_EVENT, JSON.stringify({ ...t.event, configVersion: read.governingVersion, adoption: read.governingAdoption })])
          await onStep?.('event')
          const row = (
            await client.query<StoredPropertyRow>(
              `INSERT INTO world_properties (id, world_id, city_id, city_instance_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id,
                                             district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version, activated_in_play_session)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${PROPERTY_COLUMNS}`,
              [
                property.propertyId,
                actor.scope.worldId,
                read.cityId,
                read.instance,
                asset.chain,
                asset.standard,
                asset.contract,
                asset.tokenId,
                property.collection.key,
                t.plot.districtKey,
                t.plot.ward,
                t.plot.plot,
                t.plot.plotId,
                property.buildingId,
                t.districtGeometryFingerprint,
                t.to,
                read.governingAdoption,
                read.governingVersion,
                actor.id,
              ],
            )
          ).rows[0]
          await onStep?.('property')
          return { fresh: true, property: recordOf(row), sequence: t.to, transition: t }
        })
      } catch (err) {
        if (err instanceof WorldPropertyRefusal) throw err
        if (err instanceof WorldRefusal) throw new WorldPropertyRefusal('world_unavailable', err.message)
        // The session expired after it was checked above and before the database checked it again: rolled back.
        if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && err.message === GUARD_SESSION_NOT_LIVE) throw new WorldPropertyRefusal('session_ended', 'The play session ended before the activation was written.')
        throw err
      }
      if (result.fresh) log.info('world property activated', { world: actor.scope.worldId, property: result.property.id, asset: assetKey(asset), plot: result.property.plotId, sequence: result.sequence })
      return result
    },
  }
}

/**
 * The only composition a mutation route may use: `requireActor` (the cookie's live session must be exactly the one
 * the page drew, and Play must answer `active` now), then `authorize` (what the route alone can check about the
 * actor, before any database work), then the store.
 */
export function createPropertyActivationService({ sessions, store }: { sessions: Pick<PlaySessionService, 'requireActor'>; store: WorldPropertyStore }) {
  return {
    async activate(
      presented: string | null,
      expected: ExpectedActor,
      input: PropertyActivationInput,
      { authorize, ...options }: ActivationOptions & { authorize?: (actor: LivePlaySession) => void } = {},
    ): Promise<PropertyActivationResult> {
      const actor = await sessions.requireActor(presented, expected)
      authorize?.(actor)
      return store.activate(actor, input, options)
    },
  }
}
