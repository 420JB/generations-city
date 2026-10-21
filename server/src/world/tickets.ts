import pg, { type PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import { assetKey, MAX_RULE_REF_LENGTH, worldProperty, type NftAsset } from '../engine'
import type { Logger } from '../log'
import type { LivePlaySession } from '../play/session'
import {
  claimWindowFor,
  decideNftDistrict,
  DistrictTicketRefusal,
  expireLapsed,
  insertTicket,
  issueFallback,
  lockRotation,
  namedTicket,
  releaseTicket,
  rotationBasis,
  ruleTicketChange,
  supersedeChangedRuleTickets,
  syncAssignmentRotation,
  TICKET_COLUMNS,
  ticketOf,
  type DistrictTicket,
  type Issue,
  type NftDistrictDecision,
  type RotationRow,
  type TicketEligibility,
  type TicketRow,
} from './rotation'
import { lockWorldForAssignment, WorldRefusal, type LockedWorld, type WorldScope } from './store'

/**
 * DISTRICT TICKETS (P1-C2-D1, migration 0010; owner-locked policies D1 to D4, P1-C2-D2, migration
 * 0011): the default assignment of MCD 46A/46B, made durable and concurrent. LOCAL ONLY, like every
 * write a player can cause: the one caller is the local property rehearsal (`rehearsal.ts`), whose
 * eligibility, explicit rules and Proofy rule answers are a server-trusted local fixture (never
 * Proofy Core's verdict), and the database refuses a rotation, slot, window or ticket anywhere but a
 * local database.
 *
 *   ENTRY       A player who enters a world's city (an authenticated actor the trusted source finds
 *               eligible) is given a ticket at once: their existing active ticket if they hold one (a
 *               reload, a relaunch, another tab or session of theirs: never a second one, never a
 *               skipped district), otherwise the oldest released slot of the world's rotation,
 *               otherwise the next ordinal. Entrants never wait for each other: A, B and C entering in
 *               that order hold districts 1, 2 and 3 at the same time, and may activate in any order.
 *   ROTATION    One per world, shared by every collection: the governing configuration's UNRESTRICTED
 *               districts in order (D1, `src/world/assignment.ts`). Ordinal n of an epoch names
 *               districts[(n - start) mod length]. The high-water mark (ordinals issued) and the
 *               committed count (tickets consumed) are separate numbers; neither drives the other.
 *   RESTRICTED  (D1) A district with a Proofy rule is reached only by a RULE TICKET: an explicit rule for
 *               the NFT names it and the district's rule answers `true` for the player (no answer, an
 *               unknown or conflicting one, or `false`, is refused). A city whose every district is
 *               restricted has nothing to assign at entry: entry answers `awaiting: 'asset'` (the
 *               bounded onboarding exception: nothing is held, nobody waits) for a player with an NFT
 *               such a rule ticket could place, and the player's selection of that NFT
 *               (`assign` without a ticket) issues it. Anyone else is refused, and may still view.
 *   SLOTS       Each ordinal is a slot with a GENERATION: reissuing a released slot gives it the next
 *               generation and a new ticket id, so a page still naming the old ticket cannot commit.
 *   LEASE       (D2) A player's CLAIM WINDOW opens with the first ticket issued to them and lasts exactly
 *               900 seconds by this database's clock. Every ticket issued to them while it is open (an
 *               NFT switch, re-entry after cancelling, a reissue) ends when it ends: no renewal. It
 *               closes when one of its tickets becomes a property (the next NFT starts a new window, no
 *               sign-out needed) or once it has run out (a fresh claim then opens a new one).
 *   LIFETIME    A ticket ends exactly once: released by its holder (or replaced by another assignment
 *               of theirs), expired by this database's clock, superseded by a change ('rotation' or
 *               'rules'), or committed by the activation that consumed it. A slot whose ticket ended
 *               without a property goes back to the gap pool in the same transaction, and the database
 *               refuses any other outcome.
 *   RULES       (D3) Explicit rules that apply to the NFT the player selects replace their fallback
 *               ticket with a rule ticket for that NFT (the fallback slot returns to the pool unused)
 *               before any plot is chosen. Rules naming different districts are refused, whatever
 *               their order, id or type, until the configuration is fixed; agreeing rules all count.
 *   CHANGES     (D4) A change of the rotation (default districts, order or geometry) begins a new epoch
 *               in the adoption's own transaction (`syncAssignmentRotation`, called by `store.ts`):
 *               every active ticket is superseded and each fallback one with time left reissued to its
 *               holder in the old order, in their window. A change of rules only supersedes exactly the
 *               rule tickets it affects (`ruleTicketChange`, on every ticket transaction; a Proofy rule
 *               change of a district also in the adoption's transaction) and keeps every other ticket
 *               whole. A superseded holder keeps their window; their next request is checked afresh.
 *   COMMIT      Only inside a property activation (`properties.ts`), under the city lock, where the
 *               ticket's whole permission is checked again.
 *
 * Locks, always in this order: the city row (FOR SHARE here, FOR UPDATE to adopt or activate), the
 * play session (FOR SHARE), the rotation row, then windows, tickets and slots (every path to those
 * holds the rotation row first). Every transaction is short; none is held while a player chooses.
 */
export { DistrictTicketRefusal, type DistrictTicket, type DistrictTicketRefusalCode } from './rotation'

/** Points inside a ticket transaction at which a test may act, to prove what concurrency does. */
export type TicketStep = 'entry-locked' | 'issued' | 'released' | 'reassigning'

export interface DistrictTicketStoreOptions {
  mode: AppMode
  log: Logger
  /** The server-trusted source of eligibility, explicit rules and Proofy rule answers (the local fixture). */
  eligibility: TicketEligibility
  onStep?: (step: TicketStep) => void | Promise<void>
}

export interface EntryResult {
  /** The player's live ticket, or null in a city whose every district is restricted (see `awaiting`). */
  ticket: DistrictTicket | null
  /** false when the player already held this active ticket, or none was issued: nothing was. */
  fresh: boolean
  /** 'asset': no ticket yet, because the district depends on the NFT; the player selects it (`assign` without a ticket). */
  awaiting: 'asset' | null
}

export interface DistrictTicketStore {
  /** Enter the city: the player's active ticket, a new one from the rotation, or (all districts restricted) `awaiting: 'asset'`. */
  enter(actor: LivePlaySession): Promise<EntryResult>
  /** The player's live ticket in the session's world, if it still stands, or null. Read only: issues, expires and supersedes nothing. */
  current(actor: LivePlaySession): Promise<DistrictTicket | null>
  /**
   * The NFT the player selected: the ticket that may place it (the same one, or a rule or fallback ticket in its place).
   * `ticketId` null names the ticket the player holds, or, in a city whose every district is restricted, none: then a
   * rule ticket is issued for the NFT if its rule authorizes it.
   */
  assign(actor: LivePlaySession, ticketId: string | null, asset: NftAsset): Promise<{ ticket: DistrictTicket; changed: boolean }>
  /** The player leaves the claim flow: the ticket ends and its slot returns to the gap pool. Their claim window does not. */
  release(actor: LivePlaySession, ticketId: string): Promise<DistrictTicket>
}

/** What `world_district_tickets_guard` (0010) raises when a ticket would be issued with its lease already over. Migrations never change, so neither does this text. */
const GUARD_TICKET_ISSUED_EXPIRED = 'a district ticket cannot be issued already expired'
/** PL/pgSQL `RAISE EXCEPTION` without an ERRCODE. */
const RAISE_EXCEPTION = 'P0001'

/**
 * A ticket issued in an open claim window ends when the window ends, which may come after the window was read and before
 * the database checks it again on insert (a switch, a re-entry after cancelling, a window in its last instant). Only that
 * refusal, by its exact text, is the player's `ticket_expired`; it is thrown, so the whole transaction rolls back (an old
 * ticket stays as it was, and its slot with it). Anything else is rethrown.
 */
async function issued<T>(insert: Promise<T>): Promise<T> {
  try {
    return await insert
  } catch (err) {
    if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && err.message === GUARD_TICKET_ISSUED_EXPIRED) throw new DistrictTicketRefusal('ticket_expired', 'Your claim window ran out before a district could be assigned in it.')
    throw err
  }
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

/** The refusal for an NFT whose district the rules refuse to decide. */
function decisionRefusal(d: Extract<NftDistrictDecision, { kind: 'refused' }>): DistrictTicketRefusal {
  switch (d.code) {
    case 'district_rule_ambiguous':
      return new DistrictTicketRefusal(d.code, `Explicit district rules for this NFT name different districts (${d.detail}); it cannot be placed until the city's rules are fixed.`)
    case 'district_rule_ref_too_long':
      return new DistrictTicketRefusal(d.code, `The explicit district rules for this NFT agree, but their ids together are ${d.detail} characters, more than a ticket records (${MAX_RULE_REF_LENGTH}).`)
    case 'district_rule_unqualified':
      return new DistrictTicketRefusal(d.code, `An explicit rule places this NFT in ${d.detail}, a restricted district whose Proofy rule you do not meet.`)
    case 'district_rule_unverified':
      return new DistrictTicketRefusal(d.code, `An explicit rule places this NFT in ${d.detail}, a restricted district, and there is no answer to its Proofy rule for you.`)
  }
}

export function createDistrictTicketStore(db: Database, { mode, log, eligibility, onStep }: DistrictTicketStoreOptions): DistrictTicketStore {
  if (eligibility.source !== 'local-fixture') throw new Error('district tickets are issued only on the local rehearsal fixture: no verified eligibility source exists')
  const isRefusal = (err: unknown) => err instanceof DistrictTicketRefusal || err instanceof WorldRefusal

  /**
   * One short ticket transaction. A refusal decided after something durable happened (leases that ran out were
   * expired, their slots returned, changed rule tickets superseded) is RETURNED by `work`, so that much commits, and
   * thrown after.
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

  /**
   * The start of every ticket transaction that may issue: the world (city FOR SHARE), the session, the rotation on the
   * governing configuration, leases and windows that ran out ended, and rule tickets a rule change affected superseded.
   */
  async function begin(client: PoolClient, actor: LivePlaySession) {
    const read = await lockWorldForAssignment(client, actor.scope)
    const player = await lockSession(client, actor)
    const rotation = await rotationFor(client, actor.scope, read)
    await expireLapsed(client, actor.scope.worldId)
    const changed = await supersedeChangedRuleTickets(client, actor.scope.worldId, read, eligibility)
    for (const c of changed) log.info('district ticket superseded by a rule change', { world: actor.scope.worldId, ticket: c.id, reason: c.reason })
    return { read, player, rotation }
  }

  /** What the trusted source decides for one NFT of this player, in this city. */
  const decide = (read: LockedWorld, actor: LivePlaySession, player: { discordUserId: string }, asset: NftAsset) =>
    decideNftDistrict(read, eligibility.matches(asset), (rule) => eligibility.ruleAnswer({ guildId: actor.scope.discordGuildId, discordUserId: player.discordUserId }, rule), eligibility.source)

  const heldBy = async (client: PoolClient, worldId: string, player: { discordUserId: string }) =>
    (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 AND actor_discord_user_id = $2 AND status = 'active' FOR UPDATE`, [worldId, player.discordUserId])).rows[0] ?? null

  return {
    async enter(actor) {
      const result = await run<{ ticket: TicketRow | null; fresh: boolean; awaiting: 'asset' | null }>(async (client) => {
        // The city FOR SHARE: an adoption or an activation (FOR UPDATE) waits for this short transaction, or it for them.
        const { read, player, rotation } = await begin(client, actor)
        await onStep?.('entry-locked')
        // Re-entry (reload, relaunch, another tab or session): the same ticket, never a second one, never a skipped district.
        const held = await heldBy(client, actor.scope.worldId, player)
        if (held) {
          if (held.actor_core_user_id !== player.coreUserId) return new DistrictTicketRefusal('ticket_not_live', 'This Discord account holds a district ticket under another Proofy identity.')
          return { ticket: held, fresh: false, awaiting: null }
        }
        // Eligible: at least one NFT the trusted source admits, of this city's collections, not placed yet.
        const waiting = eligibility.assets(player).filter((a) => {
          const p = worldProperty(read.world, a)
          return p !== null && !Object.hasOwn(read.state.buildings, p.buildingId)
        })
        if (waiting.length === 0) return new DistrictTicketRefusal('not_eligible', 'No eligible NFT of this city is waiting to be placed.')
        if (rotation.districts.length === 0) {
          // Every district is restricted (D1): the district depends on the NFT, so the player selects it first. Nothing is
          // held meanwhile, so nobody waits. Only a player with an NFT a rule ticket could place gets that far.
          const decisions = waiting.map((a) => decide(read, actor, player, a))
          if (decisions.some((d) => d.kind === 'rule')) return { ticket: null, fresh: false, awaiting: 'asset' }
          const refused = decisions.flatMap((d) => (d.kind === 'refused' ? [d] : []))
          for (const code of ['district_rule_unqualified', 'district_rule_unverified', 'district_rule_ambiguous', 'district_rule_ref_too_long'] as const) {
            const first = refused.find((d) => d.code === code)
            if (first) return decisionRefusal(first)
          }
          return new DistrictTicketRefusal('no_default_district', 'Every district of this city is restricted, and no explicit rule places an NFT of yours in one.')
        }
        const window = await claimWindowFor(client, actor.scope.worldId, player, true)
        const ticket = await issued(issueFallback(client, rotation, { scope: actor.scope, actor: player, sessionRef: actor.id, world: read.world, window }))
        await onStep?.('issued')
        return { ticket, fresh: true, awaiting: null }
      })
      if (result.fresh && result.ticket)
        log.info('district ticket issued', { world: actor.scope.worldId, ticket: result.ticket.id, district: result.ticket.district_key, ordinal: result.ticket.ordinal, generation: result.ticket.generation })
      return { ticket: result.ticket ? ticketOf(result.ticket) : null, fresh: result.fresh, awaiting: result.awaiting }
    },

    async current(actor) {
      const row = (
        await db.query<TicketRow>(
          `SELECT ${TICKET_COLUMNS} FROM world_district_tickets
            WHERE world_id = $1 AND actor_discord_user_id = $2 AND actor_core_user_id = $3 AND status = 'active' AND expires_at > clock_timestamp()`,
          [actor.scope.worldId, actor.player.discordUserId, actor.player.coreUserId],
        )
      ).rows[0]
      if (!row) return null
      if (row.kind === 'rule') {
        // A rule ticket a rule change affected is not offered: the next ticket transaction supersedes it.
        const client = await db.connect()
        try {
          const read = await lockWorldForAssignment(client, actor.scope)
          if (ruleTicketChange(row, read, eligibility) !== null) return null
        } catch (err) {
          if (err instanceof WorldRefusal) throw new DistrictTicketRefusal('world_unavailable', err.message)
          throw err
        } finally {
          client.release()
        }
      }
      return ticketOf(row)
    },

    async assign(actor, ticketId, asset) {
      const result = await run(async (client) => {
        const { read, player, rotation } = await begin(client, actor)
        let named: TicketRow | null
        if (ticketId !== null) {
          const found = await namedTicket(client, actor.scope.worldId, ticketId, player)
          if (found instanceof DistrictTicketRefusal) return found
          named = found
        } else {
          named = await heldBy(client, actor.scope.worldId, player)
          if (named && named.actor_core_user_id !== player.coreUserId) return new DistrictTicketRefusal('ticket_not_live', 'This Discord account holds a district ticket under another Proofy identity.')
          // Only where entry can assign nothing (every district restricted) does a selection come without a ticket.
          if (!named && rotation.districts.length > 0) return new DistrictTicketRefusal('ticket_not_live', 'Enter the city first: it assigns your district.')
        }
        const key = assetKey(asset)
        if (!eligibility.assets(player).some((a) => assetKey(a) === key)) return new DistrictTicketRefusal('not_eligible', 'That NFT is not one you may place.')
        const property = worldProperty(read.world, asset)
        if (!property) return new DistrictTicketRefusal('asset-not-in-world')
        if (Object.hasOwn(read.state.buildings, property.buildingId)) return new DistrictTicketRefusal('asset-already-placed')
        const decided = decide(read, actor, player, asset)
        if (decided.kind === 'refused') return decisionRefusal(decided)
        if (decided.kind === 'rule') {
          if (named && named.kind === 'rule' && named.asset === key && named.district_key === decided.district && named.rule_ref === decided.ruleRef && ruleTicketChange(named, read, eligibility) === null)
            return { ticket: named, changed: false }
          // A replacement is issued in the player's open window (never renewed); only a first ticket opens one.
          const window = await claimWindowFor(client, actor.scope.worldId, player, named === null)
          // The rule decides this NFT's district: the fallback slot goes back to the gap pool, unused, before any plot is chosen.
          if (named) await releaseTicket(client, named, 'reassigned')
          await onStep?.('reassigning')
          const issue: Issue = { scope: actor.scope, actor: player, sessionRef: actor.id, world: read.world, window }
          return { ticket: await issued(insertTicket(client, rotation, issue, { kind: 'rule', district: decided.district, asset: key, ruleRef: decided.ruleRef, authorization: decided.authorization })), changed: true }
        }
        // No explicit rule assigns this NFT: the default rotation does, which a city of restricted districts does not have.
        if (!named || rotation.districts.length === 0) return new DistrictTicketRefusal('no_default_district', 'Every district of this city is restricted, and no explicit rule places this NFT in one.')
        if (named.kind === 'fallback') return { ticket: named, changed: false }
        // A rule ticket, and the player selected an NFT no rule assigns: back to the rotation, in the same window.
        const window = await claimWindowFor(client, actor.scope.worldId, player, false)
        await releaseTicket(client, named, 'reassigned')
        await onStep?.('reassigning')
        return { ticket: await issued(issueFallback(client, rotation, { scope: actor.scope, actor: player, sessionRef: actor.id, world: read.world, window })), changed: true }
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
        // The ticket ends; the claim window does not (D2): entering again within it is assigned in it, never renewed.
        const row = await releaseTicket(client, named, 'cancel')
        await onStep?.('released')
        return row
      })
      log.info('district ticket released', { world: actor.scope.worldId, ticket: released.id, district: released.district_key, ordinal: released.ordinal })
      return ticketOf(released)
    },
  }
}
