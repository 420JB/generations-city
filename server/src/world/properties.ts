import pg, { type PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import {
  assetKey,
  nftAsset,
  PROPERTY_ACTIVATED_EVENT,
  proposePropertyActivation,
  worldCityStateText,
  worldProperty,
  type DistrictRuleMatch,
  type PropertyActivationRefusal,
  type PropertyTransition,
  type RuleAnswer,
} from '../engine'
import type { Logger } from '../log'
import type { ExpectedActor, LivePlaySession, PlaySessionService } from '../play/session'
import { consumeTicket, districtRule, DistrictTicketRefusal, lockTicketForCommit, ticketPlacementRefusal, type TicketEligibility, type TicketPlacementRefusal, type TicketRow } from './rotation'
import { lockWorldForChange, WorldRefusal, type ActivatorIdentity, type ConfirmActive } from './store'

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
 *                                   appends its `world.property.activated` event, freezes the
 *                                   world's district geometry if this is its first property, and
 *                                   writes the property with its original activator, or writes
 *                                   nothing.
 *
 * GEOMETRY FREEZE (migration 0008, locked policy). A world's first successful activation records
 * the geometry of the configuration version that governed it (`world_geometry_freezes`), in its own
 * transaction, under the city lock every configuration adoption also takes. A refused, failed or
 * rolled-back activation freezes nothing. Every later property stands on that geometry, and every
 * version that governs the world afterwards must draw it (`store.ts`, and the database's guards).
 *
 * STALE MAPS (P1-C2-B2C-H). A player chooses a plot on the city their page drew, and before the
 * first property a configuration adoption may redraw the districts under the same plot ids. So an
 * activation names the layout geometry fingerprint of the city it was chosen on, and under the city
 * lock it must be the governing geometry's, or it is refused (`config_superseded`) before anything is
 * written: an identical plot id is not the same ground on another geometry. The page then shows the
 * city as it is and the player chooses again.
 *
 * PLAY'S ACTIVE CONFIGURATION (P1-C2-B2C-H). The configuration that governs a world is the one the
 * installation had active when a launch adopted it, and adoption waits for a launch. A world's first
 * property freezes the governing geometry for good, so it must not freeze a version Play no longer
 * has active: before the freeze, with the city lock held, Play is asked once (`activeConfig`, contract
 * §4.4) which version and hash the installation has active, and unless that is exactly the governing
 * version the activation is refused (`config_superseded`; the player relaunches, which adopts it).
 * No answer in time refuses it too (`active_config_unverified`): a first property is never written
 * on an uncertain configuration. Every adoption takes the same lock, so none slips in between. Play's
 * pointer can still move after Play answered; that publish then comes after this property, and the
 * new version must draw the frozen geometry to govern, as for any later publish.
 *
 * ORIGINAL ACTIVATOR (migration 0008, locked policy). Each property records, for good, the Core user
 * id and Discord user id of the player who activated it: read from the activating play session's
 * own row (Play's redeemed run, signed by Proofy Core), locked in this transaction, never from the
 * request. It is not the NFT's current holder, and it outlives the session, which is tidied after
 * its retention.
 *
 * Who may act: `createPropertyActivationService` takes the browser's cookie and the session,
 * world and player the page drew, and goes through `requireActor` (a fresh Play check, no cache,
 * no grace) before the store is asked. The store itself takes only a `LivePlaySession`, and the
 * database refuses a property whose session is not live and of this world.
 *
 * Idempotency: a property's id is derived from (world, NFT), so the same NFT can never be placed
 * twice. The same player repeating an activation that already happened (same NFT, same plot)
 * changes nothing and is answered with the property as it was (`fresh: false`), through any later
 * legitimate session of theirs. Anyone else gets the refusal `asset-already-placed` and learns
 * nothing about who placed it or in which session; so does the same NFT on another plot. "The same
 * player" is the property's original activator: the same Core user id and Discord user id. (A
 * property written before migration 0008 has no recorded activator; for it, the Discord user of the
 * activating session counts while that session's row is still kept, as before.)
 *
 * The session is locked (FOR SHARE) right after the city, and must be live then: a sign-out, a
 * newer launch or Play ending the session either came first and the activation is refused
 * (`session_ended`), or waits until it commits. If the session expires between that check and the
 * database's own (`world_properties_guard`), the database's refusal is answered the same way.
 * Concurrent activations queue on the city's row lock, and each is judged on the city as the one
 * before it left it: two on one plot give one property and one `plot-unavailable`.
 *
 * DISTRICT TICKETS (P1-C2-D1, migration 0010). An activation may name the district ticket it uses
 * (`ActivationOptions.ticket`; the local rehearsal always does). Then, under the city lock and after
 * the idempotency answer, the ticket is locked (after the rotation) and must be the activator's live
 * ticket of the rotation's current epoch, issued on the geometry that governs now; the plot must be
 * one the engine offers in the ticket's district; an NFT an explicit rule assigns needs that rule's
 * ticket (`district_rule_applies` for a fallback ticket), and conflicting rules are refused. The
 * ticket is consumed (committed, its slot consumed, counted, its holder's claim window closed) after
 * the property is written, in the same transaction, so a refused or failed activation consumes
 * nothing and freezes nothing, and a repeat of a completed activation consumes nothing more. In a
 * world with a rotation the database refuses a property that consumed no ticket.
 *
 * RESTRICTED DISTRICTS (policy D1, P1-C2-D2). A plot in a district with a Proofy rule is placed only
 * with a rule ticket for that district that still stands EXACTLY as issued, judged again here under
 * the city lock: the NFT's explicit rules (from the caller's trusted source) name that district with
 * the same rule ids, the configuration names the same Proofy rule for it, and that rule answers
 * `true` for the activator now, from the same source. A failed, missing, unknown or conflicting
 * answer refuses (`district_rule_unqualified`, `district_rule_unverified`); a changed rule refuses
 * the ticket (`ticket_superseded`). Locally the source is the rehearsal fixture: test data, never a
 * verified Proofy Core answer.
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
  /**
   * The city the page chose on is not the one that governs now (its geometry changed), or, for a world's first property,
   * Play has another configuration version active than the one that governs. Nothing was written.
   */
  | 'config_superseded'
  /** A world's first property, and Play did not say in time which configuration it has active. Nothing was written. */
  | 'active_config_unverified'
  /** The named district ticket is not the activator's live ticket in this world (unknown, someone else's, released or committed). */
  | 'ticket_not_live'
  /** The named district ticket's lease ran out. */
  | 'ticket_expired'
  /** The city's rotation or geometry changed since the ticket was issued: it no longer authorizes anything. */
  | 'ticket_superseded'
  /** The plot is not in the district the ticket assigns. */
  | 'plot_outside_assignment'
  /** An explicit rule assigns this NFT's district: a fallback ticket cannot place it. */
  | 'district_rule_applies'
  /** Explicit rules for this NFT name different districts, and no precedence between them is approved. */
  | 'district_rule_ambiguous'
  /** Explicit rules for this NFT agree, but their ids together are longer than a ticket can record. */
  | 'district_rule_ref_too_long'
  /** The NFT's rules place it in a restricted district whose Proofy rule answered that the activator does not qualify. */
  | 'district_rule_unqualified'
  /** The NFT's rules place it in a restricted district, and there is no answer (missing, unknown, conflicting) to its Proofy rule for the activator. */
  | 'district_rule_unverified'
  /** The rule ticket was issued for another NFT. */
  | 'ticket_asset_mismatch'

export class WorldPropertyRefusal extends Error {
  readonly code: WorldPropertyRefusalCode
  constructor(code: WorldPropertyRefusalCode, message: string = code) {
    super(message)
    this.name = 'WorldPropertyRefusal'
    this.code = code
  }
}

/**
 * What an activation names: an NFT, as untyped input, the exact plot the player chose, and the layout geometry fingerprint
 * of the city it was chosen on (`PlayWorld.definition.geometryFingerprint` as the page drew it).
 */
export interface PropertyActivationInput {
  asset: { chain: unknown; contract: unknown; tokenId: unknown; standard?: unknown }
  plotId: unknown
  geometryFingerprint: unknown
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
  /** The activating play session. Internal provenance: never answered to a browser. */
  sessionRef: string
  /** The original activator, permanent (0008). Null only for a property written before 0008. */
  activator: ActivatorIdentity | null
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
  /** Present when `fresh` and the activation used a district ticket: the ticket it consumed. */
  ticketId?: string
}

/**
 * Points inside the write at which a test may make it fail, or act, to prove nothing is left half-written. `locked`: the
 * city is locked, the session not yet. `ticket`: the named district ticket is locked and judged live for the plot.
 * `consumed`: the ticket was consumed, after the property. `confirmed`: only for a world's first property, once Play confirmed its active
 * configuration and before anything is written. `freeze`: only for a world's first property, after its geometry freeze is
 * written.
 */
export type ActivationStep = 'locked' | 'ticket' | 'confirmed' | 'city' | 'event' | 'freeze' | 'property' | 'consumed'

export interface ActivationOptions {
  /**
   * Refuse a plot in a district that has a Proofy rule (`district-rule-unverified`), judged on the configuration that
   * governs the world under its lock, unless the activation's rule ticket for exactly that district stands, its rule
   * answered again now (D1). A caller that cannot verify a rule must not place anything there.
   */
  refuseRuleGatedDistricts?: boolean
  /**
   * Play's active configuration for the actor's installation, asked only for a world's first property, with the city
   * locked (`PlaySessionService.activeConfig`). Without it a first property is refused (`active_config_unverified`).
   */
  activeConfig?: ConfirmActive
  /**
   * The district ticket this activation uses (migration 0010), the explicit district rules the caller's trusted source
   * says match the NFT, and that source's answer to a Proofy rule for a player of a Discord server (asked again here for
   * a restricted district). Required by the local rehearsal; a world with a rotation refuses a property without one.
   */
  ticket?: { id: string; matches: readonly DistrictRuleMatch[]; ruleAnswer: TicketEligibility['ruleAnswer']; source: TicketEligibility['source'] }
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
/** What `world_district_tickets_guard` (0010) raises when a ticket's lease ran out after the store checked it. */
const GUARD_TICKET_EXPIRED = 'an expired district ticket cannot be committed'
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
  activator_core_user_id: string | null
  activator_discord_user_id: string | null
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
  activator: r.activator_core_user_id !== null && r.activator_discord_user_id !== null ? { coreUserId: r.activator_core_user_id, discordUserId: r.activator_discord_user_id } : null,
  activatedAt: r.activated_at.toISOString(),
})

const PROPERTY_COLUMNS =
  'id, world_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id, district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version, activated_in_play_session, activator_core_user_id, activator_discord_user_id, activated_at'

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
          // came first and is seen here, or waits for this activation to commit. Its row names the player, as Proofy
          // Play's redeemed run named them: the only source of the original activator.
          const live = (
            await client.query<{ core_user_id: string; discord_user_id: string }>(
              'SELECT core_user_id, discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE',
              [actor.id, actor.scope.worldId],
            )
          ).rows
          if (live.length !== 1) throw new WorldPropertyRefusal('session_ended', 'The play session ended before the activation was written.')
          const activator: ActivatorIdentity = { coreUserId: live[0].core_user_id, discordUserId: live[0].discord_user_id }
          // The plot was chosen on the city the page drew. On any other geometry the same plot id may be other ground.
          if (input.geometryFingerprint !== read.world.layout.geometryFingerprint)
            throw new WorldPropertyRefusal('config_superseded', 'The city\'s districts changed after this page drew it; nothing was placed.')

          const property = worldProperty(read.world, asset)
          if (!property) throw new WorldPropertyRefusal('asset-not-in-world')

          // Idempotent for the player who activated it, and only for them: anyone else learns only that the NFT is placed.
          const existing = (await client.query<StoredPropertyRow>(`SELECT ${PROPERTY_COLUMNS} FROM world_properties WHERE id = $1`, [property.propertyId])).rows[0]
          if (existing) {
            if (existing.world_id !== actor.scope.worldId || existing.plot_id !== plotId) throw new WorldPropertyRefusal('asset-already-placed')
            if (existing.activator_core_user_id !== null || existing.activator_discord_user_id !== null) {
              if (existing.activator_core_user_id !== activator.coreUserId || existing.activator_discord_user_id !== activator.discordUserId) throw new WorldPropertyRefusal('asset-already-placed')
            } else {
              // Written before 0008: no recorded activator, so the activating session's player, while its row is kept.
              const session = (await client.query<{ discord_user_id: string }>('SELECT discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2', [existing.activated_in_play_session, actor.scope.worldId])).rows[0]
              if (session?.discord_user_id !== activator.discordUserId) throw new WorldPropertyRefusal('asset-already-placed')
            }
            return { fresh: false, property: recordOf(existing), sequence: read.sequence }
          }

          // The district ticket: the activator's, live, of the rotation's current epoch (locked after the rotation).
          let held: TicketRow | null = null
          if (options.ticket) {
            const locked = await lockTicketForCommit(client, actor.scope.worldId, options.ticket.id, activator)
            if (locked instanceof DistrictTicketRefusal) throw new WorldPropertyRefusal(locked.code as 'ticket_not_live' | 'ticket_expired' | 'ticket_superseded', locked.message)
            held = locked
          }

          const proposed = proposePropertyActivation(read.world, read.state, read.sequence, { asset, plotId })
          if (!proposed.ok) throw new WorldPropertyRefusal(proposed.reason)
          const t = proposed.transition
          if (held && options.ticket) {
            const where = { guildId: actor.scope.discordGuildId, discordUserId: activator.discordUserId }
            const answer = options.ticket.ruleAnswer
            const refused: TicketPlacementRefusal | null = ticketPlacementRefusal(held, read, {
              districtKey: t.plot.districtKey,
              asset: assetKey(asset),
              matches: options.ticket.matches,
              answer: (rule): RuleAnswer => answer(where, rule),
              source: options.ticket.source,
            })
            if (refused) throw new WorldPropertyRefusal(refused)
            await onStep?.('ticket')
          }
          // A restricted district: only its own standing rule ticket, judged again just above, places anything there.
          const gate = districtRule(read.config, t.plot.districtKey)
          const gateAuthorized = gate !== null && held !== null && held.kind === 'rule' && held.district_key === t.plot.districtKey && held.gate_rule_id !== null && Number(held.gate_rule_id) === gate
          if (options.refuseRuleGatedDistricts && gate !== null && !gateAuthorized) throw new WorldPropertyRefusal('district-rule-unverified')
          // The first property freezes the governing geometry for good: only while Play, asked now, has exactly that version active.
          if (!read.freeze) {
            const active = options.activeConfig ? await options.activeConfig().catch(() => null) : null
            if (!active) throw new WorldPropertyRefusal('active_config_unverified', 'Proofy Play did not confirm which city configuration is active; nothing was placed.')
            if (active.version !== read.governingVersion || active.configHash !== read.governingConfigHash)
              throw new WorldPropertyRefusal('config_superseded', 'Proofy Play has another city configuration active than the one this city follows; nothing was placed.')
            await onStep?.('confirmed')
          }

          const moved = await client.query(
            'UPDATE city SET state = $1::json, state_version = $2, sequence = $3, updated_at = now() WHERE id = $4 AND instance_id = $5 AND sequence = $6',
            // Version 2, or 3 in a city with construction (0013): the engine's state says which.
            [worldCityStateText(t.state), t.state.version, t.to, read.cityId, read.instance, t.from],
          )
          if (moved.rowCount !== 1) throw new WorldPropertyRefusal('sequence_conflict')
          await onStep?.('city')
          await client.query('INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, $3, $4::jsonb)', [read.cityId, t.to, PROPERTY_ACTIVATED_EVENT, JSON.stringify({ ...t.event, configVersion: read.governingVersion, adoption: read.governingAdoption })])
          await onStep?.('event')
          // The world's first property freezes the geometry it stands on: the governing version's, as recorded for it.
          if (!read.freeze) {
            if (t.from !== 1) throw new WorldPropertyRefusal('world_unavailable', `world ${actor.scope.worldId} is at sequence ${t.from} without a geometry freeze`)
            await client.query(
              `INSERT INTO world_geometry_freezes (world_id, city_id, frozen_at_sequence, adoption_seq, config_version, layout_key, layout_geometry_fingerprint, districts, frozen_by)
               SELECT g.world_id, $2, $3, $4, g.version, g.layout_key, g.layout_geometry_fingerprint, g.districts, 'first-property'
                 FROM world_config_geometries g WHERE g.world_id = $1 AND g.version = $5`,
              [actor.scope.worldId, read.cityId, t.to, read.governingAdoption, read.governingVersion],
            )
            await onStep?.('freeze')
          }
          const row = (
            await client.query<StoredPropertyRow>(
              `INSERT INTO world_properties (id, world_id, city_id, city_instance_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id,
                                             district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version, activated_in_play_session,
                                             activator_core_user_id, activator_discord_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING ${PROPERTY_COLUMNS}`,
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
                activator.coreUserId,
                activator.discordUserId,
              ],
            )
          ).rows[0]
          await onStep?.('property')
          // The ticket is consumed by exactly this property, in this transaction: committed, its slot consumed, counted.
          if (held) {
            await consumeTicket(client, held, row.id, t.to)
            await onStep?.('consumed')
          }
          return { fresh: true, property: recordOf(row), sequence: t.to, transition: t, ...(held ? { ticketId: held.id } : {}) }
        })
      } catch (err) {
        if (err instanceof WorldPropertyRefusal) throw err
        if (err instanceof WorldRefusal) throw new WorldPropertyRefusal('world_unavailable', err.message)
        // The session expired after it was checked above and before the database checked it again: rolled back.
        if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && err.message === GUARD_SESSION_NOT_LIVE) throw new WorldPropertyRefusal('session_ended', 'The play session ended before the activation was written.')
        // The ticket's lease ran out after it was checked above and before the database checked it again: rolled back.
        if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && err.message === GUARD_TICKET_EXPIRED) throw new WorldPropertyRefusal('ticket_expired', 'Your district ticket expired before the activation was written.')
        throw err
      }
      if (result.fresh) log.info('world property activated', { world: actor.scope.worldId, property: result.property.id, asset: assetKey(asset), plot: result.property.plotId, sequence: result.sequence, ...(result.ticketId ? { ticket: result.ticketId } : {}) })
      return result
    },
  }
}

/**
 * The only composition a mutation route may use: `requireActor` (the cookie's live session must be exactly the one
 * the page drew, and Play must answer `active` now), then `authorize` (what the route alone can check about the
 * actor, before any database work), then the store, with Play's active configuration to ask under the city lock.
 */
export function createPropertyActivationService({ sessions, store }: { sessions: Pick<PlaySessionService, 'requireActor' | 'activeConfig'>; store: WorldPropertyStore }) {
  return {
    async activate(
      presented: string | null,
      expected: ExpectedActor,
      input: PropertyActivationInput,
      { authorize, ...options }: ActivationOptions & { authorize?: (actor: LivePlaySession) => void } = {},
    ): Promise<PropertyActivationResult> {
      const actor = await sessions.requireActor(presented, expected)
      authorize?.(actor)
      return store.activate(actor, input, { ...options, activeConfig: sessions.activeConfig(actor) })
    },
  }
}
