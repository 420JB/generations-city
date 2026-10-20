import { randomBytes, randomUUID } from 'node:crypto'
import pg, { type PoolClient } from 'pg'
import { hashSessionToken } from '../auth/service'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import type { PlayCityResponse, PlayEnvironment, PlayErrorCode, PlayFact, PlaySessionResponse, PlayViewer } from '../engine'
import { errorFields, type Logger } from '../log'
import { WorldRefusal, type ConfirmActive, type WorldScope, type WorldStore } from '../world/store'
import type { PlayGameReader, PlayRun } from './client'
import { createInstallationChecker, type InstallationVerdict } from './installationCheck'
import { ACTIVE_CONFIRM_MS, confirmActiveConfig, type PlayLaunch } from './launch'

/**
 * PLAY SESSIONS: a player who launched Rare City from Proofy Play, kept signed in to the one city
 * that launch opened (migration 0006).
 *
 * Who decides what:
 *   - Proofy Core decides WHO the player is. Its context token carries the Discord user id from
 *     Core's own Discord sign-in, signed only after Core checked live guild membership and the
 *     server's Play entitlement. Play verifies that token, pins the player to the run, and tells
 *     Rare City when it redeems the run with Rare City's service credential. That redeemed run is
 *     the only source of a player here: nothing the browser says is an identity.
 *   - The launch path and the world store decide WHICH CITY (`launch.ts`, `world/store.ts`).
 *   - This service opens a session only for a launch both of them accepted, and from then on the
 *     session alone says which city a request reads. No request names an installation or a world.
 *
 * The credential is 32 random bytes in an HttpOnly cookie for this origin only; only its SHA-256
 * is stored (the same scheme as wallet sessions, `auth/service.ts`, in a table of its own: a
 * Proofy player is not a wallet user, and no `users` row is made for one).
 *
 * LIFETIME. A session ends at the earliest of: the end of Play's run (Rare City's registered
 * maxRunSeconds), PLAY_SESSION_MAX_MS after it opened, logout, a newer launch by the same player in
 * the same browser, and a definite no from Play (the installation no longer active, or Rare City
 * itself refused). It is never extended or renewed: the way
 * back in is a new launch from Proofy Play, which is when Core checks the player's membership and
 * the server's entitlement again. Rare City has no way to ask Core about either in between
 * (no such contract), so the viewer says they were verified AT LAUNCH, never "now".
 *
 * PLAY'S AUTHORITY, ON EVERY READ (`installationCheck.ts`). Reading the city needs the database
 * and Play's word that the installation is still active:
 *   - `active` (asked now, or within INSTALLATION_CHECK_CACHE_MS): the city is served.
 *   - a definite no ends the session for good (revoked, cookie cleared, 403): the installation
 *     suspended, uninstalled, not shown or not this one (`installation_not_active`), or Play
 *     refusing Rare City itself, its credential or its game (`play_authorization_refused`).
 *   - no authoritative answer (unreachable, timed out, malformed): the city is still served, saying
 *     `installationActive: unknown`, for at most PLAY_SESSION_GRACE_MS after Play's last `active`
 *     for that installation in this process (a launch's own check counts). Past it, or with no
 *     such reading, the read is refused for now (503 `installation_unverified`): the session is
 *     kept, and serves again as soon as Play answers `active`.
 * The grace period is for VIEWING only. Nothing that acts for a player may lean on it or on the
 * cache: `requireActor` asks Play afresh and accepts only `active`.
 *
 * WHO IS ACTING. A browser holds one play session, and a launch in one tab replaces the session
 * every other tab of that browser was showing. So a page knows which session it drew
 * (`viewer.session.ref`, an identifier, never a credential), and anything that acts must name it,
 * with the world and the player it expects, and be refused unless the cookie's session is exactly
 * that one (`requireActor`). Nor does a launch change who a browser is: a run for another player
 * than its live session opens nothing (app.ts), so a link carrying someone else's run token cannot
 * sign a signed-in browser in as them.
 */

/** The longest a play session lasts, however long Play's run is. */
export const PLAY_SESSION_MAX_MS = 12 * 60 * 60_000
/** A run with less than this left opens no session: the launch is answered as expired. */
export const MIN_PLAY_SESSION_MS = 60_000
/** How long a city read waits for Play to say whether the installation is still active. */
export const INSTALLATION_CHECK_MS = 3_000
/** How long Play's "active" is reused for other reads of the same installation. A "not active" is never reused: it ends the session. */
export const INSTALLATION_CHECK_CACHE_MS = 15_000
/**
 * How long after Play's last "active" for an installation a read may still be served when Play gives no
 * authoritative answer. Viewing only; never anything that acts.
 */
export const PLAY_SESSION_GRACE_MS = 60_000
/** Ended sessions are deleted this long after they ended. */
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000
const TIDY_EVERY_MS = 15_000

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/

/** A refusal of the session layer, as the status and `{ "error": code }` it is answered with. */
export class PlaySessionError extends Error {
  readonly status: number
  readonly code: PlayErrorCode
  constructor(status: number, code: PlayErrorCode, message: string = code) {
    super(message)
    this.name = 'PlaySessionError'
    this.status = status
    this.code = code
  }
}

/**
 * A live play session as the SERVER knows it: the row behind a presented cookie. INTERNAL: never
 * serialised. The browser learns the player and the expiry, not the row.
 */
export interface LivePlaySession {
  /** The row's id: also the page's `viewer.session.ref`. Identifies a session; authorizes nothing. */
  id: string
  scope: WorldScope
  player: PlayRun['player']
  createdAt: Date
  expiresAt: Date
}

/** What a session row records. */
export interface NewPlaySession {
  id: string
  tokenHash: Buffer
  scope: WorldScope
  player: PlayRun['player']
  runId: string
  launchConfig: { version: number; configHash: string }
  runExpiresAt: Date
  createdAt: Date
  expiresAt: Date
}

/** Where sessions are kept. `createPlaySessionStore` keeps them in Postgres. */
export interface PlaySessionStore {
  /** Record a session, retiring `retiring` (a presented cookie's hash) in the same transaction. Throws PlaySessionError('run_already_used') if the run already has one. */
  insert(session: NewPlaySession, retiring: Buffer | null): Promise<void>
  /** The live session with this hash, for this Play environment and game, by the caller's clock AND the store's. */
  find(tokenHash: Buffer, at: Date, environment: PlayEnvironment, gameKey: string): Promise<LivePlaySession | null>
  revoke(by: { tokenHash: Buffer } | { id: string }, at: Date): Promise<void>
  /** Delete sessions that ended before `before`. Best effort. */
  tidy(before: Date): Promise<void>
}

/** The pg error code for a unique key taken. */
const UNIQUE_VIOLATION = '23505'

export function createPlaySessionStore(db: Database): PlaySessionStore {
  return {
    async insert(s, retiring) {
      try {
        await withTransaction(db, () => false, async (client: PoolClient) => {
          // A browser holds one play session: the one it arrived with ends as the new one begins.
          if (retiring) await client.query('UPDATE play_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [retiring, s.createdAt])
          await client.query(
            `INSERT INTO play_sessions (id, token_hash, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, discord_user_id, core_user_id, display_name,
                                        play_run_id, launch_config_version, launch_config_hash, run_expires_at, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
              s.id,
              s.tokenHash,
              s.scope.worldId,
              s.scope.environment,
              s.scope.gameKey,
              s.scope.installationId,
              s.scope.discordGuildId,
              s.player.discordUserId,
              s.player.coreUserId,
              s.player.displayName,
              s.runId,
              s.launchConfig.version,
              s.launchConfig.configHash,
              s.runExpiresAt,
              s.createdAt,
              s.expiresAt,
            ],
          )
        })
      } catch (err) {
        // One run, one session: the whole transaction, retirement included, was rolled back. (The token hash is 32
        // random bytes and does not collide.)
        if (err instanceof pg.DatabaseError && err.code === UNIQUE_VIOLATION && err.constraint === 'play_sessions_one_per_run') throw new PlaySessionError(409, 'run_already_used', 'This run already opened a session.')
        throw err
      }
    },

    async find(tokenHash, at, environment, gameKey) {
      const row = (
        await db.query<{ id: string; world_id: string; play_environment: PlayEnvironment; play_game_key: string; play_installation_id: string; discord_guild_id: string; discord_user_id: string; core_user_id: string; display_name: string; created_at: Date; expires_at: Date }>(
          `SELECT s.id, s.world_id, s.play_environment, s.play_game_key, s.play_installation_id, s.discord_guild_id, s.discord_user_id, s.core_user_id, s.display_name, s.created_at, s.expires_at
             FROM play_sessions s
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.expires_at > clock_timestamp()
              AND s.play_environment = $3 AND s.play_game_key = $4`,
          [tokenHash, at, environment, gameKey],
        )
      ).rows[0]
      if (!row) return null
      return {
        id: row.id,
        scope: { worldId: row.world_id, environment: row.play_environment, gameKey: row.play_game_key, installationId: row.play_installation_id, discordGuildId: row.discord_guild_id },
        player: { discordUserId: row.discord_user_id, coreUserId: row.core_user_id, displayName: row.display_name },
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
    },

    async revoke(by, at) {
      if ('id' in by) await db.query('UPDATE play_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [by.id, at])
      else await db.query('UPDATE play_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [by.tokenHash, at])
    },

    async tidy(before) {
      await db.query('DELETE FROM play_sessions WHERE expires_at < $1 OR revoked_at < $1', [before])
    },
  }
}

/** A play session opened by a launch. `token` is the cookie value: set once, never stored or logged. */
export interface OpenedPlaySession {
  token: string
  maxAgeSeconds: number
  response: PlaySessionResponse
}

/** What an action names as its actor: the session the page drew, and the world and player it showed. */
export interface ExpectedActor {
  sessionRef: string
  worldId: string
  discordUserId: string
}

export interface PlaySessionService {
  /** Open this browser's play session for a launch the launch path and world store accepted. `presented` (a cookie it carried) is retired. */
  open(launch: PlayLaunch, presented: string | null): Promise<OpenedPlaySession>
  /** The live session behind this cookie value. Throws PlaySessionError: 401 `play_session_required`, 503 when it cannot be read. */
  session(presented: string | null): Promise<LivePlaySession>
  /** The live session behind this cookie value, or null if there is none. Throws PlaySessionError 503 when it cannot be read. */
  current(presented: string | null): Promise<LivePlaySession | null>
  /**
   * A live session's city. Throws PlaySessionError: 403 `installation_not_active` or `play_authorization_refused`
   * (and the session is over), 503 `installation_unverified` (Play gave no answer past the grace period; the
   * session is kept), 503 when it cannot be read.
   */
  city(session: LivePlaySession): Promise<PlayCityResponse>
  /**
   * The session that may act, for anything that acts for a player (nothing does yet). The cookie's live session
   * must be exactly `expected`'s, and Play must answer `active` now: no cache, no grace. Throws PlaySessionError:
   * 401 `play_session_required`, 409 `play_actor_mismatch`, 403 as `city`, 503 `installation_unverified`.
   */
  requireActor(presented: string | null, expected: ExpectedActor): Promise<LivePlaySession>
  /**
   * Play's ACTIVE configuration for a live session's installation (contract §4.4), asked once when the returned
   * function is called: by the property store, with the world's lock held, before a world's first property freezes
   * its geometry. Null unless Play answers within ACTIVE_CONFIRM_MS that the installation is still the session's and
   * active. Server to Play only: nothing the browser says reaches it. Never throws.
   */
  activeConfig(session: LivePlaySession): ConfirmActive
  /** End the session behind this cookie value. Unknown or missing values are a no-op. */
  logout(presented: string | null): Promise<void>
}

export interface PlaySessionOptions {
  store: PlaySessionStore
  worlds: WorldStore
  play: PlayGameReader
  /** The Play environment of Rare City's credential. Only its sessions are ever read. */
  environment: PlayEnvironment
  gameKey: string
  log: Logger
  now?: () => Date
  /** Source of session credentials. Tests may replace it; production never does. */
  random?: (bytes: number) => Buffer
  installationCheckMs?: number
  installationCacheMs?: number
  graceMs?: number
  /** Monotonic milliseconds, the launch service's clock too. Tests may replace it. */
  clock?: () => number
  /** Tests only: the deadline for Play's answer in `activeConfig`. */
  activeConfirmMs?: number
}

const atLaunch = (source: 'proofy-core' | 'proofy-play', at: Date): PlayFact<true> => ({ status: 'verified', value: true, source, basis: 'launch', at: at.toISOString() })

/** What a session's viewer is told: who Proofy says they are, what was verified when, and what is not known. */
function viewerOf(
  ref: string,
  player: PlayRun['player'],
  createdAt: Date,
  expiresAt: Date,
  installationActive: PlayFact<true>,
  { originalActivations, unrecordedActivations }: { originalActivations: string[]; unrecordedActivations: string[] },
): PlayViewer {
  return {
    authenticated: true,
    player: { discordUserId: player.discordUserId, coreUserId: player.coreUserId, displayName: player.displayName },
    session: { ref, expiresAt: expiresAt.toISOString(), renewal: 'relaunch' },
    status: {
      // Core signs a launch context only for a member of the server it is for, and only for an entitled server.
      guildMember: atLaunch('proofy-core', createdAt),
      playEntitled: atLaunch('proofy-core', createdAt),
      installationActive,
      brandAdmin: { status: 'unknown', reason: 'not-in-contract' },
      districtRules: { status: 'unknown', reason: 'not-checked' },
    },
    permissions: { viewCity: true, claim: false, build: false },
    originalActivations,
    unrecordedActivations,
  }
}

export function createPlaySessionService(options: PlaySessionOptions): PlaySessionService {
  const { store, worlds, play, environment, gameKey, log } = options
  const now = options.now ?? (() => new Date())
  const random = options.random ?? randomBytes
  const graceMs = options.graceMs ?? PLAY_SESSION_GRACE_MS
  const checker = createInstallationChecker({
    play,
    environment,
    gameKey,
    log,
    checkMs: options.installationCheckMs ?? INSTALLATION_CHECK_MS,
    cacheMs: options.installationCacheMs ?? INSTALLATION_CHECK_CACHE_MS,
    graceMs,
    clock: options.clock,
    now,
  })
  let tidiedAt = Number.NEGATIVE_INFINITY

  const hashOf = (presented: string | null) => (presented && SESSION_TOKEN.test(presented) ? hashSessionToken(presented) : null)
  const unavailable = (what: string, err: unknown) => {
    log.error(`play session ${what} failed`, errorFields(err))
    return new PlaySessionError(503, 'play_session_unavailable')
  }

  async function tidy(at: Date) {
    if (at.getTime() - tidiedAt < TIDY_EVERY_MS) return
    tidiedAt = at.getTime()
    try {
      await store.tidy(new Date(at.getTime() - SESSION_RETENTION_MS))
    } catch {
      // Tried again on a later launch.
    }
  }

  async function find(presented: string | null): Promise<LivePlaySession | null> {
    const hash = hashOf(presented)
    if (!hash) return null
    try {
      return await store.find(hash, now(), environment, gameKey)
    } catch (err) {
      throw unavailable('read', err)
    }
  }

  /** A definite no from Play: the session is over, not merely refused this once. Throws. */
  async function end(session: LivePlaySession, verdict: Extract<InstallationVerdict, { kind: 'inactive' | 'refused' }>): Promise<never> {
    await store.revoke({ id: session.id }, now()).catch((err: unknown) => log.warn('play session revocation failed', errorFields(err)))
    if (verdict.kind === 'refused') {
      log.info('play session ended: proofy play refused rare city', { installation: session.scope.installationId, world: session.scope.worldId, code: verdict.code })
      throw new PlaySessionError(403, 'play_authorization_refused')
    }
    log.info('play session ended: installation not active', { installation: session.scope.installationId, world: session.scope.worldId })
    throw new PlaySessionError(403, 'installation_not_active')
  }

  const unverified = () => new PlaySessionError(503, 'installation_unverified', 'Proofy Play has not confirmed the installation recently enough.')

  return {
    async open(launch, presented) {
      const at = now()
      const runEnds = Date.parse(launch.play.runExpiresAt)
      const expiresAt = new Date(Math.min(runEnds, at.getTime() + PLAY_SESSION_MAX_MS))
      // Play's run is the grant: a session never outlives it, and one about to end is not worth opening.
      if (!(expiresAt.getTime() - at.getTime() >= MIN_PLAY_SESSION_MS)) throw new PlaySessionError(409, 'run_expired', 'The run ends too soon to open a session.')

      const token = random(32).toString('base64url')
      const id = randomUUID()
      const scope: WorldScope = { worldId: launch.world.id, environment: launch.play.environment, gameKey: launch.play.gameKey, installationId: launch.play.installationId, discordGuildId: launch.play.discordGuildId }
      try {
        await store.insert(
          {
            id,
            tokenHash: hashSessionToken(token),
            scope,
            player: launch.player,
            runId: launch.play.runId,
            launchConfig: { version: launch.play.configVersion, configHash: launch.play.configHash },
            runExpiresAt: new Date(runEnds),
            createdAt: at,
            expiresAt,
          },
          hashOf(presented),
        )
      } catch (err) {
        if (err instanceof PlaySessionError) throw err
        throw unavailable('open', err)
      }
      // The launch asked Play about the installation and it was active: where this installation's freshness starts.
      checker.verified(scope, launch.installationVerifiedAt)
      await tidy(at)
      const viewer = viewerOf(id, launch.player, at, expiresAt, atLaunch('proofy-play', at), launch)
      return {
        token,
        maxAgeSeconds: Math.floor((expiresAt.getTime() - at.getTime()) / 1000),
        response: { play: launch.play, player: { displayName: launch.player.displayName }, viewer, world: launch.world, config: launch.config },
      }
    },

    async session(presented) {
      const session = await find(presented)
      if (!session) throw new PlaySessionError(401, 'play_session_required')
      return session
    },

    current: find,

    async city(session) {
      const verdict = await checker.check(session.scope)
      if (verdict.kind === 'inactive' || verdict.kind === 'refused') return end(session, verdict)
      // No authoritative answer: viewing continues only within the grace period after Play's last "active".
      if (verdict.kind === 'unknown' && !(verdict.graceRemainingMs > 0)) throw unverified()

      let read
      try {
        read = await worlds.read(session.scope, { discordUserId: session.player.discordUserId, coreUserId: session.player.coreUserId })
      } catch (err) {
        if (err instanceof WorldRefusal) {
          log.error('play session city read refused', { world: session.scope.worldId, code: err.code, reason: err.message })
          throw new PlaySessionError(503, 'world_unavailable')
        }
        throw unavailable('city read', err)
      }
      // A cached answer is stated as of when Play gave it, not as of now.
      const installationActive: PlayFact<true> =
        verdict.kind === 'active' ? { status: 'verified', value: true, source: 'proofy-play', basis: 'live', at: verdict.verifiedAt.toISOString() } : { status: 'unknown', reason: 'authority-unavailable' }
      return {
        play: { environment: session.scope.environment, gameKey: session.scope.gameKey, installationId: session.scope.installationId, discordGuildId: session.scope.discordGuildId, configVersion: read.governing.version, configHash: read.governing.configHash, schemaVersion: read.governing.schemaVersion },
        viewer: viewerOf(session.id, session.player, session.createdAt, session.expiresAt, installationActive, read),
        world: read.world,
        config: read.governing.config,
      }
    },

    async requireActor(presented, expected) {
      const session = await find(presented)
      if (!session) throw new PlaySessionError(401, 'play_session_required')
      // The page acted on what it drew. If the browser's session is no longer that one (another tab launched, signed
      // out, or another player signed in), nothing is done as whoever holds the cookie now.
      if (session.id !== expected.sessionRef || session.scope.worldId !== expected.worldId || session.player.discordUserId !== expected.discordUserId) {
        throw new PlaySessionError(409, 'play_actor_mismatch', 'This page is not showing the session this browser holds now.')
      }
      const verdict = await checker.check(session.scope, { fresh: true })
      if (verdict.kind === 'inactive' || verdict.kind === 'refused') return end(session, verdict)
      if (verdict.kind !== 'active') throw unverified()
      return session
    },

    activeConfig: (session) => confirmActiveConfig(play, gameKey, session.scope.installationId, session.scope.discordGuildId, options.activeConfirmMs ?? ACTIVE_CONFIRM_MS),

    async logout(presented) {
      const hash = hashOf(presented)
      if (!hash) return
      try {
        await store.revoke({ tokenHash: hash }, now())
      } catch (err) {
        throw unavailable('logout', err)
      }
    },
  }
}
