import { createHash, randomBytes } from 'node:crypto'
import { getAddress, isAddress, recoverMessageAddress, zeroAddress, type Hex } from 'viem'
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import { ANONYMOUS_VIEWER_RESPONSE, RARE_FRIENDS_CHAIN, type AuthenticatedViewer, type ChallengeResponse, type IdentityErrorCode, type ViewerResponse } from '../engine'

/**
 * Wallet sign-in and server sessions.
 *
 * A wallet proves control of its address by signing a one-time EIP-4361 ("Sign-In with
 * Ethereum") message that this service wrote and stored. The signature is checked against
 * the stored text, never against anything the browser sends back, so the address, the
 * chain, the origin and the lifetime it covers cannot be swapped. Signature recovery is
 * viem's; nothing here implements cryptography.
 *
 * A successful sign-in opens a session: 32 random bytes handed to the browser in an
 * HttpOnly cookie. Only their SHA-256 is stored, so the database holds nothing that can be
 * presented as a credential.
 */

/** How long a wallet has to sign a challenge. */
export const CHALLENGE_TTL_MS = 5 * 60_000
/** Absolute session lifetime. It is not extended by use; signing in again opens a new one. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
/**
 * Ceiling on stored challenges. Asking for a challenge needs no credentials, so the table is
 * kept to the newest this many: a flood ages out the oldest requests instead of refusing new
 * ones, and to push a real visitor's challenge out before they sign it an attacker has to
 * issue this many in those few seconds.
 */
export const MAX_CHALLENGES = 20_000
/** Expired and consumed challenges are kept this long, then deleted. */
const CHALLENGE_RETENTION_MS = 60 * 60_000
/** Sessions that ended this long ago are deleted. */
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000
/** How often the tables are tidied, at most. */
const TIDY_EVERY_MS = 15_000

const STATEMENT = 'Sign in to Rare City. This only proves you control this wallet: it is not a transaction and it costs nothing.'

const NONCE = /^[0-9a-f]{32}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/

export class AuthError extends Error {
  readonly code: IdentityErrorCode
  readonly status: number
  constructor(status: number, code: IdentityErrorCode) {
    super(code)
    this.name = 'AuthError'
    this.status = status
    this.code = code
  }
}

export interface AuthOptions {
  db: Database
  /** `scheme://host[:port]` this service is reached at. Written into every challenge. */
  publicOrigin: string
  now?: () => Date
  /** Source of nonces and session credentials. Tests may replace it; production never does. */
  random?: (bytes: number) => Buffer
  /** Overrides MAX_CHALLENGES, for tests. */
  maxChallenges?: number
}

export interface OpenedSession {
  /** The cookie value. Returned once, to be set on the response, and never stored or logged. */
  token: string
  expiresAt: Date
  /** Cookie lifetime: the session's own, so the browser forgets the credential when the server does. */
  maxAgeSeconds: number
  viewer: AuthenticatedViewer
}

/**
 * A live session as the SERVER knows it: the exact database rows behind a presented cookie.
 *
 * INTERNAL. It exists for work that must be tied to one exact session (activation binds an
 * intent to the session that asked for it). It is never serialised: the session and wallet
 * row ids are of no use to a browser, and `viewer()` deliberately leaves them out.
 */
export interface LiveSession {
  sessionId: string
  userId: string
  walletId: string
  /** Lowercase, as stored. */
  address: string
  chainId: number
  expiresAt: Date
}

export interface AuthService {
  issueChallenge(input: unknown): Promise<ChallengeResponse>
  /** `presented` is the session cookie the request carried, if any: that session is retired. */
  verify(input: unknown, presented: string | null): Promise<OpenedSession>
  /** Revoke the session behind this cookie value. Unknown or missing values are a no-op. */
  logout(presented: string | null): Promise<void>
  /** Who this cookie value belongs to. Anything not a live session is anonymous. */
  viewer(presented: string | null): Promise<ViewerResponse>
  /**
   * The exact live session behind this cookie value, or null. Server-side only: see `LiveSession`.
   * Live by this service's clock AND the database's, so a session one of them calls over is over.
   */
  session(presented: string | null): Promise<LiveSession | null>
}

/** A lowercase address, or null when the input is not an acceptable EVM address. */
export function normalizeAddress(input: unknown): string | null {
  // Strict: a mixed-case address must carry a valid EIP-55 checksum, which catches typos.
  if (typeof input !== 'string' || !isAddress(input)) return null
  const lower = input.toLowerCase()
  return lower === zeroAddress ? null : lower
}

export const hashSessionToken = (token: string): Buffer => createHash('sha256').update(token).digest()

/** Only these keys, each present. Anything else is not the request this endpoint takes. */
export function exactKeys<K extends string>(input: unknown, keys: readonly K[]): Record<K, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const own = Object.keys(input)
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return null
  return input as Record<K, unknown>
}

export function createAuthService(options: AuthOptions): AuthService {
  const { db, publicOrigin, maxChallenges = MAX_CHALLENGES } = options
  const now = options.now ?? (() => new Date())
  const random = options.random ?? randomBytes
  const domain = new URL(publicOrigin).host
  const chainId = RARE_FRIENDS_CHAIN.chainId
  let tidiedAt = Number.NEGATIVE_INFINITY

  /**
   * Keep the identity tables bounded. Occasional and best effort: a failure here must never
   * fail a sign-in. Everything it deletes is already dead (expired, consumed, or pushed out
   * by newer challenges), so nothing it removes could have authenticated anyone.
   */
  async function tidy(at: Date) {
    if (at.getTime() - tidiedAt < TIDY_EVERY_MS) return
    tidiedAt = at.getTime()
    try {
      await db.query('DELETE FROM auth_challenges WHERE expires_at < $1', [new Date(at.getTime() - CHALLENGE_RETENTION_MS)])
      await db.query('DELETE FROM auth_challenges WHERE nonce IN (SELECT nonce FROM auth_challenges ORDER BY expires_at DESC, nonce OFFSET $1)', [maxChallenges])
      await db.query('DELETE FROM sessions WHERE expires_at < $1', [new Date(at.getTime() - SESSION_RETENTION_MS)])
    } catch {
      // Tried again on a later request.
    }
  }

  const liveSession = (presented: string | null) => (presented && SESSION_TOKEN.test(presented) ? hashSessionToken(presented) : null)

  return {
    async issueChallenge(input) {
      const body = exactKeys(input, ['address', 'chainId'])
      if (!body) throw new AuthError(400, 'invalid_request')
      const address = normalizeAddress(body.address)
      if (!address || typeof body.chainId !== 'number') throw new AuthError(400, 'invalid_request')
      if (body.chainId !== chainId) throw new AuthError(400, 'unsupported_chain')

      const issuedAt = now()
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)
      const nonce = random(16).toString('hex')
      const message = createSiweMessage({ address: getAddress(address), chainId, domain, uri: publicOrigin, version: '1', nonce, statement: STATEMENT, issuedAt, expirationTime: expiresAt })

      await db.query('INSERT INTO auth_challenges (nonce, chain_id, address, message, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [nonce, chainId, address, message, issuedAt, expiresAt])
      await tidy(issuedAt)
      return { nonce, message, expiresAt: expiresAt.toISOString() }
    },

    async verify(input, presented) {
      const body = exactKeys(input, ['nonce', 'signature'])
      if (!body || typeof body.nonce !== 'string' || !NONCE.test(body.nonce) || typeof body.signature !== 'string' || !SIGNATURE.test(body.signature)) throw new AuthError(400, 'invalid_request')
      const { nonce, signature } = body as { nonce: string; signature: string }
      const at = now()

      const challenge = (await db.query<{ chain_id: number; address: string; message: string; expires_at: Date; consumed_at: Date | null }>('SELECT chain_id, address, message, expires_at, consumed_at FROM auth_challenges WHERE nonce = $1', [nonce])).rows[0]
      if (!challenge || challenge.consumed_at || challenge.expires_at.getTime() <= at.getTime()) throw new AuthError(401, 'challenge_invalid')
      // The stored text must still be one this deployment would issue: same origin, same chain, same address.
      const fields = parseSiweMessage(challenge.message)
      if (challenge.chain_id !== chainId || fields.chainId !== chainId || fields.uri !== publicOrigin || !validateSiweMessage({ message: fields, address: getAddress(challenge.address), domain, nonce, time: at }))
        throw new AuthError(401, 'challenge_invalid')

      let signer: string
      try {
        signer = (await recoverMessageAddress({ message: challenge.message, signature: signature as Hex })).toLowerCase()
      } catch {
        throw new AuthError(401, 'signature_invalid')
      }
      if (signer !== challenge.address) throw new AuthError(401, 'signature_invalid')

      const token = random(32).toString('base64url')
      const expiresAt = new Date(at.getTime() + SESSION_TTL_MS)
      const retiring = liveSession(presented)
      // One transaction, and a connection that is only pooled again when it is known to be out of it (`withTransaction`).
      // The only refusal raised in here is this service's own AuthError; anything else that is not the database's
      // own answer leaves the connection in an unknown state, and it is closed rather than reused.
      return withTransaction(
        db,
        (err) => err instanceof AuthError,
        async (client) => {
          // The one statement that decides a race: of any number of verifications of this nonce, exactly one updates the row.
          const consumed = await client.query('UPDATE auth_challenges SET consumed_at = $2 WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2', [nonce, at])
          if (consumed.rowCount !== 1) throw new AuthError(401, 'challenge_invalid')

          // Serialises first sign-ins of one address, so it can never become two users.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wallet:${chainId}:${challenge.address}`])
          let wallet = (await client.query<{ id: string; user_id: string }>('UPDATE wallets SET last_verified_at = $3 WHERE chain_id = $1 AND address = $2 RETURNING id, user_id', [chainId, challenge.address, at])).rows[0]
          if (!wallet) {
            const user = (await client.query<{ id: string }>('INSERT INTO users (created_at, updated_at) VALUES ($1, $1) RETURNING id', [at])).rows[0]
            wallet = (await client.query<{ id: string; user_id: string }>('INSERT INTO wallets (user_id, chain_id, address, created_at, last_verified_at) VALUES ($1, $2, $3, $4, $4) RETURNING id, user_id', [user.id, chainId, challenge.address, at])).rows[0]
          }
          // A browser holds one session: the one it arrived with ends as the new one begins.
          if (retiring) await client.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [retiring, at])
          await client.query('INSERT INTO sessions (token_hash, user_id, wallet_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [hashSessionToken(token), wallet.user_id, wallet.id, at, expiresAt])
          // The session exists only once the transaction has committed: nothing is returned, and no cookie set, before then.
          return { token, expiresAt, maxAgeSeconds: SESSION_TTL_MS / 1000, viewer: { authenticated: true as const, userId: wallet.user_id, wallet: { address: getAddress(challenge.address), chainId }, session: { expiresAt: expiresAt.toISOString() } } }
        },
      )
    },

    async logout(presented) {
      const hash = liveSession(presented)
      if (hash) await db.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [hash, now()])
    },

    async viewer(presented) {
      const hash = liveSession(presented)
      if (!hash) return ANONYMOUS_VIEWER_RESPONSE
      const row = (
        await db.query<{ user_id: string; expires_at: Date; address: string; chain_id: number }>(
          `SELECT s.user_id, s.expires_at, w.address, w.chain_id
             FROM sessions s JOIN wallets w ON w.id = s.wallet_id
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
          [hash, now()],
        )
      ).rows[0]
      if (!row) return ANONYMOUS_VIEWER_RESPONSE
      return { authenticated: true, userId: row.user_id, wallet: { address: getAddress(row.address), chainId: row.chain_id }, session: { expiresAt: row.expires_at.toISOString() } }
    },

    async session(presented) {
      const hash = liveSession(presented)
      if (!hash) return null
      const row = (
        await db.query<{ id: string; user_id: string; wallet_id: string; expires_at: Date; address: string; chain_id: number }>(
          `SELECT s.id, s.user_id, s.wallet_id, s.expires_at, w.address, w.chain_id
             FROM sessions s JOIN wallets w ON w.id = s.wallet_id AND w.user_id = s.user_id
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.expires_at > clock_timestamp()`,
          [hash, now()],
        )
      ).rows[0]
      if (!row) return null
      return { sessionId: row.id, userId: row.user_id, walletId: row.wallet_id, address: row.address, chainId: row.chain_id, expiresAt: row.expires_at }
    },
  }
}
