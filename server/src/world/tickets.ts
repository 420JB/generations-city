import type { PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import { assetKey, resolveDistrictRules, worldProperty, type DistrictRuleMatch, type NftAsset } from '../engine'
import type { Logger } from '../log'
import type { LivePlaySession } from '../play/session'
import {
  DistrictTicketRefusal,
  expireLapsed,
  insertTicket,
  issueFallback,
  lockRotation,
  namedTicket,
  releaseTicket,
  rotationBasis,
  syncAssignmentRotation,
  TICKET_COLUMNS,
  ticketOf,
  type DistrictTicket,
  type Issue,
  type RotationRow,
  type TicketRow,
} from './rotation'
import { lockWorldForAssignment, WorldRefusal, type LockedWorld, type WorldScope } from './store'

/**
 * DISTRICT TICKETS (P1-C2-D1, migration 0010): the owner-locked default assignment of MCD 46A/46B,
 * made durable and concurrent. LOCAL ONLY, like every write a player can cause: the one caller is the
 * local property rehearsal (`rehearsal.ts`), whose eligibility is a server-trusted local fixture
 * (never Proofy Core's verdict), and the database refuses a rotation, slot or ticket anywhere but a
 * local database.
 *
 *   ENTRY       A player who enters a world's city (an authenticated actor the caller found eligible)
 *               is given a ticket at once: their existing active ticket if they hold one (a reload, a
 *               relaunch, another tab or session of theirs: never a second one, never a skipped
 *               district), otherwise the oldest released slot of the world's rotation, otherwise the
 *               next ordinal. Entrants never wait for each other: A, B and C entering in that order
 *               hold districts 1, 2 and 3 at the same time, and may activate in any order.
 *   ROTATION    One per world, shared by every collection: the governing configuration's districts in
 *               order, without the rule-gated ones (`src/world/assignment.ts`). Ordinal n of an epoch
 *               names districts[(n - start) mod length]. The high-water mark (ordinals issued) and the
 *               committed count (tickets consumed) are separate numbers; neither drives the other.
 *   SLOTS       Each ordinal is a slot with a GENERATION: reissuing a released slot gives it the next
 *               generation and a new ticket id, so a page still naming the old ticket cannot commit.
 *   LIFETIME    A ticket ends exactly once: released by its holder (or replaced by another assignment
 *               of theirs), expired by this database's clock (never renewed: the lease is bounded and
 *               no renewal policy is approved), superseded by a change of the rotation, or committed by
 *               the activation that consumed it. A slot whose ticket ended without a property goes back
 *               to the gap pool in the same transaction, and the database refuses any other outcome.
 *   RULES       An explicit collection/trait rule that applies to the NFT the player selects replaces
 *               their fallback ticket with a rule ticket for that NFT (the fallback slot returns to the
 *               pool unused) before any plot is chosen. Rules naming different districts are refused.
 *   GEOMETRY    A ticket is bound to the configuration version, layout geometry and district geometry
 *               it was issued on, and to its rotation's epoch. An adoption that changes the default
 *               districts or their geometry (possible before a world's first property) begins a new
 *               epoch in the adoption's own transaction (`syncAssignmentRotation`, called by
 *               `store.ts`): active tickets are superseded and, if they have time left, reissued to
 *               their holders in the old order; the old epoch's unconsumed slots are retired.
 *   COMMIT      Only inside a property activation (`properties.ts`), under the city lock.
 *
 * Locks, always in this order: the city row (FOR SHARE here, FOR UPDATE to adopt or activate), the
 * play session (FOR SHARE), the rotation row, tickets, slots. Every transaction is short; none is held
 * while a player chooses a plot.
 */
export { DistrictTicketRefusal, type DistrictTicket, type DistrictTicketRefusalCode } from './rotation'

/** Points inside a ticket transaction at which a test may act, to prove what concurrency does. */
export type TicketStep = 'entry-locked' | 'issued' | 'released'

export interface DistrictTicketStoreOptions {
  mode: AppMode
  log: Logger
  /** How long a ticket's lease lasts, in seconds (1 to 3600; the database refuses longer). */
  ttlSeconds: number
  onStep?: (step: TicketStep) => void | Promise<void>
}

export interface EntryResult {
  ticket: DistrictTicket
  /** false when the player already held this active ticket: nothing was issued. */
  fresh: boolean
}

export interface DistrictTicketStore {
  /** Enter the city: the player's active ticket, or a new one from the rotation. `eligibleAssets` is the caller's server-side eligibility. */
  enter(actor: LivePlaySession, eligibleAssets: readonly NftAsset[]): Promise<EntryResult>
  /** The player's live ticket in the session's world, or null. Read only: issues and expires nothing. */
  current(actor: LivePlaySession): Promise<DistrictTicket | null>
  /** The NFT the player selected: the ticket that may place it (the same one, or a rule or fallback ticket in its place). */
  assign(actor: LivePlaySession, ticketId: string, asset: NftAsset, matches: readonly DistrictRuleMatch[]): Promise<{ ticket: DistrictTicket; changed: boolean }>
  /** The player leaves the claim flow: the ticket ends and its slot returns to the gap pool. Returns the released ticket. */
  release(actor: LivePlaySession, ticketId: string): Promise<DistrictTicket>
}

const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '8s'
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

/** The actor's session, locked until the transaction ends, live and of its world: the only source of who the actor is. */
async function lockSession(client: PoolClient, actor: LivePlaySession): Promise<{ discordUserId: string; coreUserId: string }> {
  const row = (
    await client.query<{ core_user_id: string; discord_user_id: string }>(
      'SELECT core_user_id, discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE',
      [actor.id, actor.scope.worldId],
    )
  ).rows[0]
  if (!row) throw new DistrictTicketRefusal('session_ended', 'The play session ended.')
  return { discordUserId: row.discord_user_id, coreUserId: row.core_user_id }
}

/** The world's rotation on its governing configuration, created (epoch 1, nothing issued) on the world's first entry. Locked. */
async function rotationFor(client: PoolClient, scope: WorldScope, read: LockedWorld): Promise<RotationRow> {
  const basis = rotationBasis(read.governingVersion, read.governingConfigHash, read.world, read.config)
  await client.query(
    `INSERT INTO world_assignment_rotations (world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts)
     VALUES ($1, 1, 0, 0, 0, $2, $3, $4, $5::jsonb) ON CONFLICT (world_id) DO NOTHING`,
    [scope.worldId, basis.configVersion, basis.configHash, basis.layoutGeometryFingerprint, JSON.stringify(basis.districts)],
  )
  const rotation = await syncAssignmentRotation(client, scope, read.world, basis)
  if (!rotation) throw new DistrictTicketRefusal('world_unavailable', `world ${scope.worldId} has no rotation after creating one`)
  return rotation
}

export function createDistrictTicketStore(db: Database, { mode, log, ttlSeconds, onStep }: DistrictTicketStoreOptions): DistrictTicketStore {
  if (!(Number.isInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= 3600)) throw new Error('a district ticket lease is a whole number of seconds from 1 to 3600')
  const isRefusal = (err: unknown) => err instanceof DistrictTicketRefusal || err instanceof WorldRefusal

  /**
   * One short ticket transaction. A refusal decided after something durable happened (leases that ran out were
   * expired, their slots returned) is RETURNED by `work`, so that much commits, and thrown after.
   */
  async function run<T>(work: (client: PoolClient) => Promise<T | DistrictTicketRefusal>): Promise<T> {
    // The service's own hold, before anything is read. The database holds the same line (0010).
    if (mode !== 'local') throw new DistrictTicketRefusal('mutations_held', 'District tickets are issued only in a local deployment.')
    let outcome: T | DistrictTicketRefusal
    try {
      outcome = await withTransaction(db, isRefusal, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
        const stamp = await environmentStamp(client)
        if (stamp !== 'local') throw new DistrictTicketRefusal('mutations_held', `the database is stamped "${stamp ?? 'unstamped'}"; district tickets are issued only in a local database`)
        return work(client)
      })
    } catch (err) {
      if (err instanceof WorldRefusal) throw new DistrictTicketRefusal('world_unavailable', err.message)
      throw err
    }
    if (outcome instanceof DistrictTicketRefusal) throw outcome
    return outcome
  }

  return {
    async enter(actor, eligibleAssets) {
      const result = await run(async (client) => {
        // The city FOR SHARE: an adoption or an activation (FOR UPDATE) waits for this short transaction, or it for them.
        const read = await lockWorldForAssignment(client, actor.scope)
        const player = await lockSession(client, actor)
        const rotation = await rotationFor(client, actor.scope, read)
        await onStep?.('entry-locked')
        await expireLapsed(client, actor.scope.worldId)
        // Re-entry (reload, relaunch, another tab or session): the same ticket, never a second one, never a skipped district.
        const held = (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 AND actor_discord_user_id = $2 AND status = 'active' FOR UPDATE`, [actor.scope.worldId, player.discordUserId])).rows[0]
        if (held) {
          if (held.actor_core_user_id !== player.coreUserId) return new DistrictTicketRefusal('ticket_not_live', 'This Discord account holds a district ticket under another Proofy identity.')
          return { ticket: held, fresh: false }
        }
        // Eligible: at least one NFT the caller admits, of this city's collections, not placed yet.
        const waiting = eligibleAssets.some((a) => {
          const p = worldProperty(read.world, a)
          return p !== null && !Object.hasOwn(read.state.buildings, p.buildingId)
        })
        if (!waiting) return new DistrictTicketRefusal('not_eligible', 'No eligible NFT of this city is waiting to be placed.')
        const ticket = await issueFallback(client, rotation, { scope: actor.scope, actor: player, sessionRef: actor.id, world: read.world, lease: { seconds: ttlSeconds } })
        await onStep?.('issued')
        return { ticket, fresh: true }
      })
      if (result.fresh) log.info('district ticket issued', { world: actor.scope.worldId, ticket: result.ticket.id, district: result.ticket.district_key, ordinal: result.ticket.ordinal, generation: result.ticket.generation })
      return { ticket: ticketOf(result.ticket), fresh: result.fresh }
    },

    async current(actor) {
      const row = (
        await db.query<TicketRow>(
          `SELECT ${TICKET_COLUMNS} FROM world_district_tickets
            WHERE world_id = $1 AND actor_discord_user_id = $2 AND actor_core_user_id = $3 AND status = 'active' AND expires_at > clock_timestamp()`,
          [actor.scope.worldId, actor.player.discordUserId, actor.player.coreUserId],
        )
      ).rows[0]
      return row ? ticketOf(row) : null
    },

    async assign(actor, ticketId, asset, matches) {
      const result = await run(async (client) => {
        const read = await lockWorldForAssignment(client, actor.scope)
        const player = await lockSession(client, actor)
        const rotation = await rotationFor(client, actor.scope, read)
        await expireLapsed(client, actor.scope.worldId)
        const named = await namedTicket(client, actor.scope.worldId, ticketId, player)
        if (named instanceof DistrictTicketRefusal) return named
        const property = worldProperty(read.world, asset)
        if (!property) return new DistrictTicketRefusal('asset-not-in-world')
        if (Object.hasOwn(read.state.buildings, property.buildingId)) return new DistrictTicketRefusal('asset-already-placed')
        const key = assetKey(asset)
        const decided = resolveDistrictRules(matches, new Set(read.world.districts.map((d) => d.key)))
        if (decided.kind === 'ambiguous')
          return new DistrictTicketRefusal('district_rule_ambiguous', `Explicit district rules for this NFT name different districts (${decided.districts.join(', ')}), and no precedence between them is approved.`)
        // A replacement keeps the lease the player had: selecting another NFT never extends it.
        const issue: Issue = { scope: actor.scope, actor: player, sessionRef: actor.id, world: read.world, lease: { until: named.expires_at } }
        if (decided.kind === 'rule') {
          if (read.config.districts.find((d) => d.key === decided.district)?.gate) return new DistrictTicketRefusal('district_rule_unverified')
          if (named.kind === 'rule' && named.asset === key && named.district_key === decided.district && named.rule_ref === decided.ruleRef) return { ticket: named, changed: false }
          // The rule decides this NFT's district: the fallback slot goes back to the gap pool, unused, before any plot is chosen.
          await releaseTicket(client, named, 'reassigned')
          return { ticket: await insertTicket(client, rotation, issue, { kind: 'rule', district: decided.district, asset: key, ruleRef: decided.ruleRef }), changed: true }
        }
        if (named.kind === 'fallback') return { ticket: named, changed: false }
        // A rule ticket, and the player selected an NFT no rule assigns: back to the rotation.
        await releaseTicket(client, named, 'reassigned')
        return { ticket: await issueFallback(client, rotation, issue), changed: true }
      })
      if (result.changed) log.info('district ticket reassigned', { world: actor.scope.worldId, ticket: result.ticket.id, kind: result.ticket.kind, district: result.ticket.district_key })
      return { ticket: ticketOf(result.ticket), changed: result.changed }
    },

    async release(actor, ticketId) {
      const released = await run(async (client) => {
        const player = await lockSession(client, actor)
        // The rotation's lock without the city's: releasing reads no city, and nothing takes the city's lock after the rotation's.
        if (!(await lockRotation(client, actor.scope.worldId))) return new DistrictTicketRefusal('ticket_not_live', 'That is not a district ticket of yours in this city.')
        await expireLapsed(client, actor.scope.worldId)
        const named = await namedTicket(client, actor.scope.worldId, ticketId, player)
        if (named instanceof DistrictTicketRefusal) return named
        const row = await releaseTicket(client, named, 'cancel')
        await onStep?.('released')
        return row
      })
      log.info('district ticket released', { world: actor.scope.worldId, ticket: released.id, district: released.district_key, ordinal: released.ordinal })
      return ticketOf(released)
    },
  }
}
