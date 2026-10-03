import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg, { type PoolClient } from 'pg'
import { recoverAddress, type Hex } from 'viem'
import { exactKeys, type LiveSession } from '../auth/service'
import { CITY_ID } from '../city/store'
import type { Database } from '../db/pool'
import {
  activateFriend,
  allocateSpecificPlot,
  checkAuthoritativeCity,
  cityMode,
  districtForFamily,
  familyById,
  isActivatable,
  isCityStateShape,
  parseCanonicalTokenId,
  parsePlotId,
  RARE_FRIENDS_CHAIN,
  STATE_VERSION,
  wardCapacity,
  type ActivationCommitResponse,
  type ActivationErrorCode,
  type ActivationIntentResponse,
  type ActivationTypedData,
  type DistrictId,
  type GameState,
  type ParsedPlot,
  type PropertyFacts,
} from '../engine'
import { errorFields, type Logger } from '../log'
import { OwnershipError, type ActivationOwnership, type OwnershipProvider } from '../ownership/provider'
import { ownershipEraId, propertyId } from './propertyId'
import { activationDigest, activationTypedData } from './typedData'

/**
 * PERMANENT FRIEND ACTIVATION: the server authority.
 *
 * A signed-in wallet that owns a Rare Friend turns it into a permanent Rare City property
 * on one exact plot. Two steps, and the city changes only in the second:
 *
 *   ISSUE   the service checks the city, the plot and (fresh, from the chain) that the
 *           session's wallet owns the Friend and which family it is; then it writes the one
 *           EIP-712 message that would authorise this activation and stores its hash. No
 *           plot is reserved and the city is not touched.
 *
 *   COMMIT  the wallet's signature over exactly that message. The service recovers the
 *           signer from the hash IT stored, reads ownership and family from the chain
 *           again, and then, in one short transaction holding the intent and the city,
 *           checks everything once more and writes the building, the event, the property,
 *           its first ownership era and the committed intent together, or nothing.
 *
 * WHAT AUTHORISES AN ACTIVATION. Not a session by itself: a session only says which wallet
 * signed in. It takes the exact session the intent was issued in, the wallet's signature
 * over the stored message, and the chain saying, at commit, that the wallet still owns the
 * Friend. Family, district and city are never taken from the request, and a user's avatar
 * (`state.users[*].friendId`) is never consulted.
 *
 * Nothing here signs or sends a transaction, and nothing here moves RF or an NFT.
 */

/** How long a wallet has to sign an intent. The database refuses anything longer (migration 0004). */
export const INTENT_TTL_MS = 10 * 60_000
/**
 * An issued intent is handed out again only while it has at least this long to live. One
 * closer to its end than that is superseded by a fresh one, so a wallet is never asked to
 * sign something about to expire.
 */
export const INTENT_REUSE_MIN_REMAINING_MS = 60_000
/** A request waits this long for the rows another activation holds, then is told to try again. */
const LOCK_TIMEOUT = '5s'
/**
 * The database gives up on any one statement of a writing transaction after this long. It is
 * below the pool's own 10-second client-side limit on purpose: the database then cancels the
 * statement and says so, instead of the service walking away from one that is still running.
 */
const STATEMENT_TIMEOUT = '8s'
/** A writing transaction left idle this long (a stalled service) is ended by the database, releasing its locks. */
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

const CHAIN_ID = RARE_FRIENDS_CHAIN.chainId
const COLLECTION = RARE_FRIENDS_CHAIN.generations.toLowerCase()
const INTENT_ID = /^[0-9a-f]{64}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/

/** The status each refusal is answered with: 4xx is the caller or the state of things, 503 an authority that could not answer. */
const STATUS: Record<ActivationErrorCode, number> = {
  activation_disabled: 403,
  not_authenticated: 401,
  invalid_request: 400,
  unsupported_chain: 400,
  city_not_activatable: 409,
  city_inconsistent: 503,
  friend_not_owned: 403,
  friend_already_activated: 409,
  ownership_unavailable: 503,
  ownership_inconsistent: 503,
  family_mismatch: 409,
  plot_invalid: 422,
  plot_unavailable: 409,
  intent_not_found: 404,
  intent_expired: 410,
  intent_superseded: 409,
  intent_session_mismatch: 403,
  signature_invalid: 403,
  activation_conflict: 409,
  activation_unavailable: 503,
}

export class ActivationError extends Error {
  readonly code: ActivationErrorCode
  readonly status: number
  constructor(code: ActivationErrorCode) {
    super(code)
    this.name = 'ActivationError'
    this.code = code
    this.status = STATUS[code]
  }
}

const refuse = (code: ActivationErrorCode) => new ActivationError(code)

/** The writes of one activation, in order. Named so a test can fail the transaction after each. */
export type CommitStep = 'city' | 'event' | 'property' | 'era' | 'intent'

export interface ActivationOptions {
  db: Database
  ownership: OwnershipProvider
  /** `scheme://host[:port]` this service is reached at. Written into every intent. */
  publicOrigin: string
  /** ACTIVATION_ENABLED. When false every method refuses before it reads anything. */
  enabled: boolean
  log: Logger
  /** Source of intent ids. Tests may replace it; production never does. */
  random?: (bytes: number) => Buffer
  /** Shortens an intent's life, for tests. Never longer than INTENT_TTL_MS. */
  intentTtlMs?: number
  /** TEST SEAM: called inside the commit transaction after each write. Production never sets it. */
  onCommitStep?: (step: CommitStep, client: PoolClient) => Promise<void> | void
}

export interface ActivationService {
  /** `session` must be the live session of the request, resolved by the auth service. */
  issueIntent(session: LiveSession, input: unknown): Promise<ActivationIntentResponse>
  commit(session: LiveSession, input: unknown): Promise<ActivationCommitResponse>
}

interface CityRow {
  id: string
  instance_id: string
  sequence: string
  state_version: number
  canonical: boolean
  origin: string
  activation_rehearsal: boolean
  state: unknown
}

interface IntentRow {
  id: string
  user_id: string
  wallet_id: string
  session_id: string | null
  owner_address: string
  chain_id: number
  collection: string
  token_id: string
  family_id: number
  city_id: string
  city_instance_id: string
  district_id: string
  ward: number
  plot: number
  plot_id: string
  origin: string
  digest: Buffer
  issued_at: Date
  expires_at: Date
  issued_block: string
  status: string
  property_id: string | null
  /** By the database clock, at the moment the row was read. */
  expired: boolean
}

const CITY_COLUMNS = 'id, instance_id, sequence, state_version, canonical, origin, activation_rehearsal, state'
const INTENT_COLUMNS = `id, user_id, wallet_id, session_id, owner_address, chain_id, collection, token_id::text AS token_id, family_id, city_id, city_instance_id,
  district_id, ward, plot, plot_id, origin, digest, issued_at, expires_at, issued_block, status, property_id, (clock_timestamp() >= expires_at) AS expired`

const pgCode = (err: unknown): string | undefined => (typeof err === 'object' && err !== null ? ((err as { code?: unknown }).code as string | undefined) : undefined)
const pgConstraint = (err: unknown): string | undefined => (typeof err === 'object' && err !== null ? ((err as { constraint?: unknown }).constraint as string | undefined) : undefined)

/**
 * What a database refusal means for the caller, where it means something. A lock that could
 * not be had in time, or a uniqueness rule another activation got to first, is a conflict
 * to retry or give up on. Anything else is not the caller's doing and is rethrown.
 */
function translate(err: unknown): unknown {
  if (err instanceof ActivationError) return err
  const code = pgCode(err)
  // lock_not_available, deadlock_detected, serialization_failure
  if (code === '55P03' || code === '40P01' || code === '40001') return refuse('activation_conflict')
  if (code === '23505') {
    const constraint = pgConstraint(err)
    if (constraint === 'p_one_per_friend' || constraint === 'properties_pkey' || constraint === 'p_one_building') return refuse('friend_already_activated')
    if (constraint === 'p_one_per_plot') return refuse('plot_unavailable')
    return refuse('activation_conflict')
  }
  return err
}

export function createActivationService(options: ActivationOptions): ActivationService {
  const { db, ownership, publicOrigin, enabled, log, onCommitStep } = options
  const random = options.random ?? randomBytes
  const intentTtlMs = Math.min(options.intentTtlMs ?? INTENT_TTL_MS, INTENT_TTL_MS)

  /**
   * One transaction on one connection. It ends in COMMIT or it ends in nothing.
   *
   * A connection goes back to the pool only when it is known to be outside a transaction.
   * A refusal this service decided on, or an error the database itself reported, leaves the
   * connection answering, and ROLLBACK is sent. Anything else (a statement that timed out on
   * this side, a dropped connection) means a statement may still be running there, and a
   * ROLLBACK queued behind it may never be sent: the connection is CLOSED instead, which makes
   * the database abandon the transaction. So is one whose ROLLBACK failed. A connection that
   * might still hold half an activation is never handed to another request to commit.
   */
  async function transaction<T>(begin: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect()
    let discard = false
    try {
      await client.query(begin)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      if (err instanceof ActivationError || err instanceof pg.DatabaseError) {
        await client.query('ROLLBACK').catch(() => {
          discard = true
        })
      } else {
        discard = true
      }
      throw translate(err)
    } finally {
      client.release(discard)
    }
  }

  /**
   * A transaction that writes. It gives up on a lock rather than queue behind another
   * activation, and the database itself bounds every statement and the time it may sit idle.
   */
  const writing = <T>(work: (client: PoolClient) => Promise<T>) =>
    transaction('BEGIN', async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
      return work(client)
    })

  /**
   * The guards of migration 0004 check time again, with their own reading of the clock, as
   * each row is written. An intent or a session can therefore run out in the instant after
   * this service looked and before the database did, and the guard refuses the write (all of
   * it rolls back). That is the caller's answer, not a failure: this asks the database what
   * ran out and says so. Anything else a guard refused stays the failure it is.
   */
  async function ranOut(err: unknown, session: LiveSession, intentId: string | null): Promise<unknown> {
    // raise_exception: what a guard trigger raises.
    if (pgCode(err) !== 'P0001') return err
    try {
      const now = (
        await db.query<{ live: boolean; expired: boolean | null }>(
          `SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) AS live,
                  (SELECT clock_timestamp() >= i.expires_at FROM activation_intents i WHERE i.id = $2) AS expired`,
          [session.sessionId, intentId],
        )
      ).rows[0]
      if (now.expired) return refuse('intent_expired')
      if (!now.live) return refuse('not_authenticated')
    } catch {
      // The original failure stands.
    }
    return err
  }

  /** Step 1 of everything, again: the HTTP layer has already refused, and this refuses for any other caller. */
  function assertUsable(session: LiveSession) {
    if (!enabled) throw refuse('activation_disabled')
    if (session.chainId !== CHAIN_ID) throw refuse('unsupported_chain')
  }

  const readCity = async (client: PoolClient, lock: boolean) => (await client.query<CityRow>(`SELECT ${CITY_COLUMNS} FROM city WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [CITY_ID])).rows[0]

  /** Every normalized property of the city, as the invariant check reads them. `instances` are the installations they name. */
  async function readProperties(client: PoolClient, cityId: string): Promise<{ facts: PropertyFacts[]; instances: Set<string> }> {
    const { rows } = await client.query<{ id: string; city_instance_id: string; token_id: string; family_id: number; district_id: string; ward: number; plot: number; plot_id: string; building_id: string }>(
      'SELECT id, city_instance_id, token_id::text AS token_id, family_id, district_id, ward, plot, plot_id, building_id FROM properties WHERE city_id = $1',
      [cityId],
    )
    return {
      facts: rows.map((p) => ({ propertyId: p.id, tokenId: p.token_id, familyId: p.family_id, districtId: p.district_id, ward: p.ward, plot: p.plot, plotId: p.plot_id, buildingId: p.building_id })),
      instances: new Set(rows.map((p) => p.city_instance_id)),
    }
  }

  /**
   * THE DEEP CHECK. The city must be one that may hold real properties, in a state this
   * build can read, sound in itself, and in exact parity with its property rows. Returns
   * the state, now typed; throws when the city is anything else. Used on the state an
   * intent is issued against, on the locked state before a commit writes, and on the
   * stored state after it has written.
   */
  function soundState(city: CityRow | undefined, properties: { facts: PropertyFacts[]; instances: Set<string> }, when: string): GameState {
    // No city is never an invitation to make one: installing a city is an operator's act.
    if (!city) throw refuse('city_not_activatable')
    const flags = { canonical: city.canonical, origin: city.origin, activationRehearsal: city.activation_rehearsal }
    const mode = cityMode(flags)
    if (mode === null || !isActivatable(mode)) throw refuse('city_not_activatable')
    const check = checkAuthoritativeCity({ flags, state: city.state, properties: properties.facts })
    const foreign = [...properties.instances].some((instance) => instance !== city.instance_id)
    if (city.state_version !== STATE_VERSION || !isCityStateShape(city.state) || check.violations.length > 0 || foreign) {
      log.error('city failed its authoritative invariants: activation refused', { when, sequence: city.sequence, violations: check.violations.length, rule: check.violations[0]?.rule ?? (foreign ? 'city-instance' : 'state-version') })
      throw refuse('city_inconsistent')
    }
    return city.state
  }

  /** The plot must be one a joining Friend may take right now, by the engine's own allocation rules. */
  function assertCandidate(state: GameState, plot: ParsedPlot) {
    if (allocateSpecificPlot(state, plot)) return
    // A real plot of an open ward that is not a candidate is one somebody has. Anything else is not a plot to take.
    const open = state.wards[plot.districtId] ?? 1
    throw refuse(plot.ward < open && plot.plot < wardCapacity(plot.ward) ? 'plot_unavailable' : 'plot_invalid')
  }

  /** The fresh pinned read. "Could not tell" is its own answer and is never "not owned". */
  async function verify(address: string, tokenId: bigint, when: string): Promise<ActivationOwnership> {
    try {
      return await ownership.verifyActivation(address, tokenId)
    } catch (err) {
      const reason = err instanceof OwnershipError ? err.reason : 'unavailable'
      // By name and code only: a provider's own message can contain its endpoint.
      log.warn('activation ownership read failed', { when, reason, ...errorFields(err instanceof OwnershipError && err.cause ? err.cause : err) })
      // A Friend that does not exist is owned by nobody: the caller's answer, not an outage.
      if (reason === 'unknown-token') throw refuse('friend_not_owned')
      if (reason === 'invalid-family' || reason === 'inconsistent') throw refuse('ownership_inconsistent')
      throw refuse('ownership_unavailable')
    }
  }

  const friendHasProperty = async (client: PoolClient, tokenId: string) =>
    (await client.query('SELECT 1 FROM properties WHERE chain_id = $1 AND collection = $2 AND token_id = $3::numeric', [CHAIN_ID, COLLECTION, tokenId])).rows.length > 0

  /**
   * The session, live by the database clock, shared-locked until the transaction ends so it
   * cannot be revoked underneath it. The database's own guard requires the same; asking
   * here turns "the session ended a moment ago" into an answer instead of a failure.
   */
  async function liveSessionRow(client: PoolClient, session: LiveSession) {
    return (
      await client.query<{ now: Date; created_at: Date; expires_at: Date }>(
        `SELECT date_trunc('milliseconds', clock_timestamp()) AS now, s.created_at, date_trunc('milliseconds', s.expires_at) AS expires_at
           FROM sessions s
          WHERE s.id = $1 AND s.user_id = $2 AND s.wallet_id = $3 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
            FOR SHARE`,
        [session.sessionId, session.userId, session.walletId],
      )
    ).rows[0]
  }

  /**
   * The message an intent row stands for, rebuilt from the row alone, and the hash that was
   * stored for it. null when they do not agree: the row is then not something this build
   * issued, and nothing is signed or recovered against it.
   */
  function rebuild(intent: IntentRow): { typedData: ActivationTypedData; digest: Hex } | null {
    const family = familyById(intent.family_id)
    if (!family || intent.chain_id !== CHAIN_ID || intent.collection !== COLLECTION || districtForFamily(intent.family_id) !== intent.district_id) return null
    const typedData = activationTypedData({
      intentId: intent.id,
      site: intent.origin,
      wallet: intent.owner_address,
      tokenId: BigInt(intent.token_id),
      family,
      cityId: intent.city_id,
      cityInstance: intent.city_instance_id,
      districtId: intent.district_id as DistrictId,
      ward: intent.ward,
      plot: intent.plot,
      issuedAt: intent.issued_at,
      expiresAt: intent.expires_at,
    })
    const digest = activationDigest(typedData)
    if (typedData.message.plotId !== intent.plot_id || digest !== `0x${intent.digest.toString('hex')}`) return null
    return { typedData, digest }
  }

  const intentResponse = (id: string, expiresAt: Date, typedData: ActivationTypedData, digest: Hex): ActivationIntentResponse => ({ intentId: id, expiresAt: expiresAt.toISOString(), typedData, digest })

  /**
   * The authoritative result of a committed intent, read from the property it created. A
   * first commit and every retry of it answer with this, from the same row.
   */
  async function committedResult(client: Pick<PoolClient, 'query'>, intent: Pick<IntentRow, 'id' | 'property_id'>): Promise<ActivationCommitResponse> {
    const p = (
      await client.query<{ id: string; city_id: string; city_instance_id: string; token_id: string; district_id: string; ward: number; plot: number; plot_id: string; building_id: string; activated_at: Date; activated_sequence: string }>(
        `SELECT id, city_id, city_instance_id, token_id::text AS token_id, district_id, ward, plot, plot_id, building_id, activated_at, activated_sequence
           FROM properties WHERE id = $1 AND activation_intent_id = $2`,
        [intent.property_id, intent.id],
      )
    ).rows[0]
    if (!p) {
      log.error('a committed activation intent has no property')
      throw refuse('activation_unavailable')
    }
    return {
      status: 'committed',
      property: { id: p.id, tokenId: p.token_id, buildingId: p.building_id, districtId: p.district_id, ward: p.ward, plot: p.plot, plotId: p.plot_id, activatedAt: p.activated_at.toISOString(), sequence: Number(p.activated_sequence) },
      city: { id: p.city_id, instance: p.city_instance_id },
    }
  }

  /**
   * An issued intent may be committed only by the exact session it was issued in, through
   * the same wallet, for this deployment's origin, and before it expires.
   */
  function assertCommittable(intent: IntentRow, session: LiveSession) {
    if (intent.session_id === null || intent.session_id !== session.sessionId || intent.wallet_id !== session.walletId || intent.owner_address !== session.address) throw refuse('intent_session_mismatch')
    if (intent.expired) throw refuse('intent_expired')
    // An intent written for another origin is not one this deployment asked anybody to sign.
    if (intent.origin !== publicOrigin) throw refuse('intent_not_found')
  }

  return {
    async issueIntent(session, input) {
      assertUsable(session)
      const body = exactKeys(input, ['tokenId', 'plotId'])
      const tokenId = body ? parseCanonicalTokenId(body.tokenId) : null
      const plot = body ? parsePlotId(body.plotId) : null
      if (tokenId === null || !plot) throw refuse('invalid_request')
      const token = tokenId.toString()

      // One consistent picture of the city and its properties. Nothing is locked: issuing reserves nothing.
      const snapshot = await transaction('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', async (client) => {
        const city = await readCity(client, false)
        return { city, properties: city ? await readProperties(client, city.id) : { facts: [], instances: new Set<string>() } }
      })
      const state = soundState(snapshot.city, snapshot.properties, 'issue')
      const instance = snapshot.city!.instance_id
      assertCandidate(state, plot)

      // The chain, fresh, at one block: does this session's wallet own the Friend, and what family is it?
      const proof = await verify(session.address, tokenId, 'issue')
      if (!proof.owned) throw refuse('friend_not_owned')
      // The district is the registry family's, and nothing else's. The request only says which plot.
      const districtId = districtForFamily(proof.family.id)
      if (!districtId) throw refuse('ownership_inconsistent')
      if (plot.districtId !== districtId) throw refuse('plot_invalid')

      const issued = await writing(async (client) => {
        // One issuance at a time per wallet and Friend: of any number of simultaneous requests, each sees what the last one did.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`activation-intent:${session.walletId}:${token}`])
        const live = await liveSessionRow(client, session)
        if (!live) throw refuse('not_authenticated')
        // The moment of issue is the database's. If it reads earlier than the session began, the two clocks disagree.
        const issuedAt = live.now
        if (issuedAt.getTime() < live.created_at.getTime()) {
          log.error('the database clock is behind the session it is asked to issue an intent in')
          throw refuse('activation_unavailable')
        }
        const expiresAt = new Date(Math.min(issuedAt.getTime() + intentTtlMs, live.expires_at.getTime()))
        if (expiresAt.getTime() <= issuedAt.getTime()) throw refuse('not_authenticated')

        // The city read above must still be the one installed: an intent names one exact installation.
        const current = (await client.query<{ instance_id: string }>('SELECT instance_id FROM city WHERE id = $1', [CITY_ID])).rows[0]
        if (!current || current.instance_id !== instance) throw refuse('activation_conflict')

        const existing = (
          await client.query<IntentRow>(
            `SELECT ${INTENT_COLUMNS} FROM activation_intents
              WHERE wallet_id = $1 AND chain_id = $2 AND collection = $3 AND token_id = $4::numeric AND status = 'issued'
                FOR UPDATE`,
            [session.walletId, CHAIN_ID, COLLECTION, token],
          )
        ).rows[0]

        if (await friendHasProperty(client, token)) throw refuse('friend_already_activated')
        if ((await client.query('SELECT 1 FROM properties WHERE city_id = $1 AND plot_id = $2', [CITY_ID, plot.plotId])).rows.length > 0) throw refuse('plot_unavailable')

        if (existing) {
          // The same request again, by the same session, while its intent still has time: the same intent, not a second one.
          const same =
            existing.session_id === session.sessionId &&
            existing.user_id === session.userId &&
            existing.city_id === CITY_ID &&
            existing.city_instance_id === instance &&
            existing.plot_id === plot.plotId &&
            existing.family_id === proof.family.id &&
            existing.origin === publicOrigin &&
            existing.expires_at.getTime() - issuedAt.getTime() >= INTENT_REUSE_MIN_REMAINING_MS
          const stored = same ? rebuild(existing) : null
          if (stored) return { response: intentResponse(existing.id, existing.expires_at, stored.typedData, stored.digest), reused: true }
          // Anything else (another session, another plot, nearly expired, a changed family) is replaced, in this same transaction.
          await client.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1 AND status = 'issued'`, [existing.id])
        }

        const id = random(32).toString('hex')
        const typedData = activationTypedData({ intentId: id, site: publicOrigin, wallet: session.address, tokenId, family: proof.family, cityId: CITY_ID, cityInstance: instance, districtId, ward: plot.ward, plot: plot.plot, issuedAt, expiresAt })
        const digest = activationDigest(typedData)
        await client.query(
          `INSERT INTO activation_intents (id, user_id, wallet_id, session_id, owner_address, chain_id, collection, token_id, family_id, city_id, city_instance_id,
                                           district_id, ward, plot, plot_id, origin, digest, issued_at, expires_at, issued_block)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [id, session.userId, session.walletId, session.sessionId, session.address, CHAIN_ID, COLLECTION, token, proof.family.id, CITY_ID, instance, districtId, plot.ward, plot.plot, plot.plotId, publicOrigin, Buffer.from(digest.slice(2), 'hex'), issuedAt, expiresAt, proof.blockNumber.toString()],
        )
        return { response: intentResponse(id, expiresAt, typedData, digest), reused: false }
      }).catch(async (err: unknown) => {
        throw await ranOut(err, session, null)
      })
      log.info('activation intent issued', { tokenId: token, plotId: plot.plotId, block: proof.blockNumber.toString(), reused: issued.reused })
      return issued.response
    },

    async commit(session, input) {
      assertUsable(session)
      const body = exactKeys(input, ['intentId', 'signature'])
      if (!body || typeof body.intentId !== 'string' || !INTENT_ID.test(body.intentId) || typeof body.signature !== 'string' || !SIGNATURE.test(body.signature)) throw refuse('invalid_request')
      const { intentId, signature } = body as { intentId: string; signature: string }

      // Everything about what was signed comes from this row. The request supplied an id and a signature, nothing more.
      const stored = (await db.query<IntentRow>(`SELECT ${INTENT_COLUMNS} FROM activation_intents WHERE id = $1`, [intentId])).rows[0]
      // Somebody else's intent is not said to exist.
      if (!stored || stored.user_id !== session.userId) throw refuse('intent_not_found')
      // THE RETRY PATH. The activation already happened; it is reported, never run again. Only to the user whose it is.
      if (stored.status === 'committed') return committedResult(db, stored)
      if (stored.status !== 'issued') throw refuse('intent_superseded')
      assertCommittable(stored, session)

      // The signer is recovered from the hash this service stored, which must be the hash of the stored fields.
      const signed = rebuild(stored)
      if (!signed) {
        log.error('a stored activation intent does not hash to its stored digest')
        throw refuse('activation_unavailable')
      }
      let signer: string
      try {
        signer = (await recoverAddress({ hash: signed.digest, signature: signature as Hex })).toLowerCase()
      } catch {
        throw refuse('signature_invalid')
      }
      // EOA only: the recovered key must be the intent's owner, which is the session's wallet.
      if (signer !== stored.owner_address || signer !== session.address) throw refuse('signature_invalid')

      // The chain again, fresh, immediately before the write and outside any transaction.
      const tokenId = BigInt(stored.token_id)
      const proof = await verify(session.address, tokenId, 'commit')
      if (!proof.owned) throw refuse('friend_not_owned')
      if (proof.family.id !== stored.family_id) throw refuse('family_mismatch')
      // A read older than the one the intent was issued on is a provider that has fallen behind, not a fresh answer.
      if (proof.blockNumber < BigInt(stored.issued_block)) {
        log.warn('activation ownership read failed', { when: 'commit', reason: 'stale-block' })
        throw refuse('ownership_unavailable')
      }

      const result = await writing(async (client) => {
        // LOCK 1: the intent. Two commits of one intent queue here, and the second finds it committed.
        const intent = (await client.query<IntentRow>(`SELECT ${INTENT_COLUMNS} FROM activation_intents WHERE id = $1 FOR UPDATE`, [intentId])).rows[0]
        if (!intent || intent.user_id !== session.userId) throw refuse('intent_not_found')
        if (intent.status === 'committed') return { response: await committedResult(client, intent), fresh: false }
        if (intent.status !== 'issued') throw refuse('intent_superseded')
        assertCommittable(intent, session)
        if (!(await liveSessionRow(client, session))) throw refuse('not_authenticated')

        // LOCK 2: the city. Every activation of this city queues here, so each sees the last one's result.
        const city = await readCity(client, true)
        if (!city || city.id !== intent.city_id || city.instance_id !== intent.city_instance_id) throw refuse('activation_conflict')
        const before = await readProperties(client, city.id)
        const state = soundState(city, before, 'before-commit')

        if (await friendHasProperty(client, intent.token_id)) throw refuse('friend_already_activated')
        if (before.facts.some((p) => p.plotId === intent.plot_id)) throw refuse('plot_unavailable')

        // The pure transition allocates the exact plot again, against the locked state.
        const outcome = activateFriend(state, { userId: intent.user_id, ownerAddress: intent.owner_address, tokenId: Number(intent.token_id), familyId: intent.family_id, address: { districtId: intent.district_id as DistrictId, ward: intent.ward, plot: intent.plot } })
        if (!outcome.ok) {
          if (outcome.reason === 'friend-active') throw refuse('friend_already_activated')
          if (outcome.reason === 'plot-unavailable') throw refuse('plot_unavailable')
          log.error('an issued activation intent cannot be applied to the city', { reason: outcome.reason })
          throw refuse('activation_unavailable')
        }

        const at = (await client.query<{ at: Date; expired: boolean }>(`SELECT date_trunc('milliseconds', clock_timestamp()) AS at, clock_timestamp() >= $1::timestamptz AS expired`, [intent.expires_at])).rows[0]
        if (at.expired) throw refuse('intent_expired')
        const previous = Number(city.sequence)
        const sequence = previous + 1
        const id = propertyId(intent.token_id)
        const block = proof.blockNumber.toString()

        // The sequence advances exactly once, and only from the value that was locked.
        const moved = await client.query('UPDATE city SET state = $1::json, sequence = $2, updated_at = $3 WHERE id = $4 AND instance_id = $5 AND sequence = $6', [JSON.stringify(outcome.state), sequence, at.at, city.id, city.instance_id, previous])
        if (moved.rowCount !== 1) throw refuse('activation_conflict')
        await onCommitStep?.('city', client)

        // Durable, public facts only. No session, credential, signature, digest or endpoint is ever written here.
        const payload = { propertyId: id, tokenId: intent.token_id, userId: intent.user_id, ownerAddress: intent.owner_address, familyId: intent.family_id, districtId: intent.district_id, ward: intent.ward, plot: intent.plot, plotId: intent.plot_id, verifiedBlock: block }
        await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, 'property.activated', $3::jsonb)`, [city.id, sequence, JSON.stringify(payload)])
        await onCommitStep?.('event', client)

        await client.query(
          `INSERT INTO properties (id, city_id, city_instance_id, chain_id, collection, token_id, family_id, district_id, ward, plot, plot_id, building_id,
                                   activated_at, activated_sequence, activated_by_user_id, activated_by_wallet_id, activation_intent_id, verified_block)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [id, city.id, city.instance_id, CHAIN_ID, COLLECTION, intent.token_id, intent.family_id, intent.district_id, intent.ward, intent.plot, intent.plot_id, outcome.building.id, at.at, sequence, intent.user_id, intent.wallet_id, intent.id, block],
        )
        await onCommitStep?.('property', client)

        await client.query(
          `INSERT INTO ownership_eras (id, property_id, era_number, owner_address, owner_wallet_id, owner_user_id, started_at, start_reason, start_block)
           VALUES ($1, $2, 1, $3, $4, $5, $6, 'activation', $7)`,
          [ownershipEraId(id, 1), id, intent.owner_address, intent.wallet_id, intent.user_id, at.at, block],
        )
        await onCommitStep?.('era', client)

        const committed = await client.query(`UPDATE activation_intents SET status = 'committed', committed_at = $2, signature = $3, property_id = $4 WHERE id = $1 AND status = 'issued'`, [intent.id, at.at, Buffer.from(signature.slice(2), 'hex'), id])
        if (committed.rowCount !== 1) throw refuse('activation_conflict')
        await onCommitStep?.('intent', client)

        // Before anything is made permanent: what is now STORED must itself pass the deep check, be exactly the
        // state the transition produced, one step on, and hold this property as this building.
        const after = await readCity(client, false)
        const stateAfter = soundState(after, await readProperties(client, city.id), 'after-commit')
        const building = Object.hasOwn(stateAfter.buildings, outcome.building.id) ? stateAfter.buildings[outcome.building.id] : undefined
        if (
          Number(after!.sequence) !== sequence ||
          !isDeepStrictEqual(stateAfter, JSON.parse(JSON.stringify(outcome.state))) ||
          !building ||
          building.ownerId !== intent.user_id ||
          building.friendId !== Number(intent.token_id) ||
          building.districtId !== intent.district_id ||
          building.ward !== intent.ward ||
          building.plot !== intent.plot
        ) {
          log.error('the stored city is not the result of the activation that was applied: rolled back', { sequence })
          throw refuse('city_inconsistent')
        }
        return { response: await committedResult(client, { id: intent.id, property_id: id }), fresh: true, block }
      }).catch(async (err: unknown) => {
        throw await ranOut(err, session, intentId)
      })
      if (result.fresh) log.info('property activated', { propertyId: result.response.property.id, tokenId: result.response.property.tokenId, plotId: result.response.property.plotId, sequence: result.response.property.sequence, block: result.block })
      return result.response
    },
  }
}
