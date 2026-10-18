import { randomBytes } from 'node:crypto'
import pg, { type PoolClient } from 'pg'
import { hashSessionToken } from '../auth/service'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import type { PlayCityResponse, PlayEnvironment, PlayErrorCode, PlayFact, PlaySessionResponse, PlayViewer } from '../engine'
import { errorFields, type Logger } from '../log'
import { WorldRefusal, type WorldScope, type WorldStore } from '../world/store'
import { PlayApiError, type PlayGameReader, type PlayRun } from './client'
import type { PlayLaunch } from './launch'

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
 * maxRunSeconds), PLAY_SESSION_MAX_MS after it opened, logout, a newer launch in the same browser,
 * and Play saying the installation is no longer active. It is never extended or renewed: the way
 * back in is a new launch from Proofy Play, which is when Core checks the player's membership and
 * the server's entitlement again. Rare City has no way to ask Core about either in between
 * (no such contract), so the viewer says they were verified AT LAUNCH, never "now".
 *
 * AUTHORITY UNAVAILABLE. Opening a session needs Play (the launch) and the database. Reading the
 * city needs the database; Play is asked whether the installation is still active, within
 * INSTALLATION_CHECK_MS. A clear "not active" or "not this installation" from Play ends the
 * session. No answer leaves it as it is and says so (`installationActive: unknown`): the session
 * is already bounded by the run, and an outage of Play does not lock players out of a city they
 * were just admitted to, nor admit anyone new.
 */

/** The longest a play session lasts, however long Play's run is. */
export const PLAY_SESSION_MAX_MS = 12 * 60 * 60_000
/** A run with less than this left opens no session: the launch is answered as expired. */
export const MIN_PLAY_SESSION_MS = 60_000
/** How long a city read waits for Play to say whether the installation is still active. */
export const INSTALLATION_CHECK_MS = 3_000
/** How long Play's "active" is reused for other reads of the same installation. A "not active" is never reused: it ends the session. */
export const INSTALLATION_CHECK_CACHE_MS = 15_000
/** Ended sessions are deleted this long after they ended. */
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000
const TIDY_EVERY_MS = 15_000
const MAX_CACHED_INSTALLATIONS = 10_000

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
  id: string
  scope: WorldScope
  player: PlayRun['player']
  createdAt: Date
  expiresAt: Date
}

/** What a session row records. */
export interface NewPlaySession {
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
            `INSERT INTO play_sessions (token_hash, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, discord_user_id, core_user_id, display_name,
                                        play_run_id, launch_config_version, launch_config_hash, run_expires_at, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
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

export interface PlaySessionService {
  /** Open this browser's play session for a launch the launch path and world store accepted. `presented` (a cookie it carried) is retired. */
  open(launch: PlayLaunch, presented: string | null): Promise<OpenedPlaySession>
  /** The live session behind this cookie value. Throws PlaySessionError: 401 `play_session_required`, 503 when it cannot be read. */
  session(presented: string | null): Promise<LivePlaySession>
  /** A live session's city. Throws PlaySessionError: 403 `installation_not_active` (and the session is over), 503 when it cannot be read. */
  city(session: LivePlaySession): Promise<PlayCityResponse>
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
}

type InstallationAnswer = 'active' | 'inactive' | 'unknown'

const atLaunch = (source: 'proofy-core' | 'proofy-play', at: Date): PlayFact<true> => ({ status: 'verified', value: true, source, basis: 'launch', at: at.toISOString() })

/** What a session's viewer is told: who Proofy says they are, what was verified when, and what is not known. */
function viewerOf(player: PlayRun['player'], createdAt: Date, expiresAt: Date, installationActive: PlayFact<true>): PlayViewer {
  return {
    authenticated: true,
    player: { discordUserId: player.discordUserId, coreUserId: player.coreUserId, displayName: player.displayName },
    session: { expiresAt: expiresAt.toISOString(), renewal: 'relaunch' },
    status: {
      // Core signs a launch context only for a member of the server it is for, and only for an entitled server.
      guildMember: atLaunch('proofy-core', createdAt),
      playEntitled: atLaunch('proofy-core', createdAt),
      installationActive,
      brandAdmin: { status: 'unknown', reason: 'not-in-contract' },
      districtRules: { status: 'unknown', reason: 'not-checked' },
    },
    permissions: { viewCity: true, claim: false, build: false },
  }
}

export function createPlaySessionService(options: PlaySessionOptions): PlaySessionService {
  const { store, worlds, play, environment, gameKey, log } = options
  const now = options.now ?? (() => new Date())
  const random = options.random ?? randomBytes
  const checkMs = options.installationCheckMs ?? INSTALLATION_CHECK_MS
  const cacheMs = options.installationCacheMs ?? INSTALLATION_CHECK_CACHE_MS
  /** installation id -> when Play last said it is active, this installation's, on this server. */
  const activeAt = new Map<string, number>()
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

  /** Whether Play still has the session's installation active, on its server, for this game. Never throws. */
  async function installation(scope: WorldScope): Promise<InstallationAnswer> {
    const cached = activeAt.get(scope.installationId)
    if (cached !== undefined && performance.now() - cached < cacheMs) return 'active'
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<InstallationAnswer>((resolve) => (timer = setTimeout(() => resolve('unknown'), checkMs)))
    const answer = play.getInstallation(scope.installationId).then(
      (i): InstallationAnswer => (i.id === scope.installationId && i.gameKey === scope.gameKey && i.discordGuildId === scope.discordGuildId && i.status === 'active' ? 'active' : 'inactive'),
      (err: unknown): InstallationAnswer => (err instanceof PlayApiError && err.code === 'installation_not_found' ? 'inactive' : 'unknown'),
    )
    try {
      const result = await Promise.race([answer, deadline])
      if (result === 'active') {
        if (activeAt.size >= MAX_CACHED_INSTALLATIONS) activeAt.clear()
        activeAt.set(scope.installationId, performance.now())
      } else {
        activeAt.delete(scope.installationId)
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async open(launch, presented) {
      const at = now()
      const runEnds = Date.parse(launch.play.runExpiresAt)
      const expiresAt = new Date(Math.min(runEnds, at.getTime() + PLAY_SESSION_MAX_MS))
      // Play's run is the grant: a session never outlives it, and one about to end is not worth opening.
      if (!(expiresAt.getTime() - at.getTime() >= MIN_PLAY_SESSION_MS)) throw new PlaySessionError(409, 'run_expired', 'The run ends too soon to open a session.')

      const token = random(32).toString('base64url')
      const scope: WorldScope = { worldId: launch.world.id, environment: launch.play.environment, gameKey: launch.play.gameKey, installationId: launch.play.installationId, discordGuildId: launch.play.discordGuildId }
      try {
        await store.insert(
          {
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
      await tidy(at)
      // The launch just read the installation from Play, and it was active.
      const viewer = viewerOf(launch.player, at, expiresAt, atLaunch('proofy-play', at))
      return {
        token,
        maxAgeSeconds: Math.floor((expiresAt.getTime() - at.getTime()) / 1000),
        response: { play: launch.play, player: { displayName: launch.player.displayName }, viewer, world: launch.world, config: launch.config },
      }
    },

    async session(presented) {
      const hash = hashOf(presented)
      if (!hash) throw new PlaySessionError(401, 'play_session_required')
      let session: LivePlaySession | null
      try {
        session = await store.find(hash, now(), environment, gameKey)
      } catch (err) {
        throw unavailable('read', err)
      }
      if (!session) throw new PlaySessionError(401, 'play_session_required')
      return session
    },

    async city(session) {
      const answer = await installation(session.scope)
      if (answer === 'inactive') {
        // Play has said so: the session is over, not merely refused this once.
        await store.revoke({ id: session.id }, now()).catch((err: unknown) => log.warn('play session revocation failed', errorFields(err)))
        log.info('play session ended: installation not active', { installation: session.scope.installationId, world: session.scope.worldId })
        throw new PlaySessionError(403, 'installation_not_active')
      }

      let read
      try {
        read = await worlds.read(session.scope)
      } catch (err) {
        if (err instanceof WorldRefusal) {
          log.error('play session city read refused', { world: session.scope.worldId, code: err.code, reason: err.message })
          throw new PlaySessionError(503, 'world_unavailable')
        }
        throw unavailable('city read', err)
      }
      const installationActive: PlayFact<true> =
        answer === 'active' ? { status: 'verified', value: true, source: 'proofy-play', basis: 'live', at: now().toISOString() } : { status: 'unknown', reason: 'authority-unavailable' }
      return {
        play: { environment: session.scope.environment, gameKey: session.scope.gameKey, installationId: session.scope.installationId, discordGuildId: session.scope.discordGuildId, configVersion: read.governing.version, configHash: read.governing.configHash, schemaVersion: read.governing.schemaVersion },
        viewer: viewerOf(session.player, session.createdAt, session.expiresAt, installationActive),
        world: read.world,
        config: read.governing.config,
      }
    },

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
