import {
  RUN_TOKEN_PATTERN,
  SUPPORTED_PLAY_SCHEMA_VERSIONS,
  type PlayEnvironment,
  type PlayErrorCode,
  type PlaySessionResponse,
  type PlayWorld,
} from '../engine'
import { WorldRefusal, type ConfirmActive, type WorldRefusalCode, type WorldStore } from '../world/store'
import { canonicalHash } from './canonical'
import { PlayApiError, type PlayGameReader, type PlayRun } from './client'

/** A refusal the launch path decided on. `problems` is set only for `config_invalid`. */
export class PlayLaunchError extends Error {
  readonly status: number
  readonly code: PlayErrorCode
  readonly problems: { path: string; detail: string }[] | undefined

  constructor(status: number, code: PlayErrorCode, message: string, problems?: { path: string; detail: string }[]) {
    super(message)
    this.name = 'PlayLaunchError'
    this.status = status
    this.code = code
    this.problems = problems
  }
}

/**
 * What a launch established, every part of it from Play and checked against the run: the city it
 * opened and the player the run names. Server-side: the session layer (`session.ts`) opens a play
 * session from it and decides what the browser is told.
 */
export interface PlayLaunch {
  play: PlaySessionResponse['play']
  /** Play's redeemed run's player: the identity a play session is opened for. */
  player: PlayRun['player']
  /**
   * When Rare City asked Play the question it answered "active" to, on the launch service's `clock`:
   * where a play session's freshness starts (`session.ts`). Never later than Play's own check.
   */
  installationVerifiedAt: number
  world: PlayWorld
  config: Record<string, unknown>
}

export interface PlayLaunchService {
  /** Open the city a Play run token was issued for. The body is untrusted. */
  open(body: Record<string, unknown>): Promise<PlayLaunch>
}

export interface PlayLaunchOptions {
  play: PlayGameReader
  /** The Play environment of Rare City's credential: what every answer is attributed to. */
  environment: PlayEnvironment
  /** Rare City's game key in Play. */
  gameKey: string
  /** Where the installation's persistent city lives. */
  worlds: WorldStore
  /** Tests only: the deadline for Play's confirmation under the world's lock. */
  activeConfirmMs?: number
  /** A monotonic clock in milliseconds, the same one the play session service reads. Tests may replace it. */
  clock?: () => number
}

/** Play's answers to a redemption, as the city states them. Anything else is Play being unavailable. */
function redeemRefusal(err: PlayApiError): PlayLaunchError | null {
  switch (err.code) {
    case 'run_token_invalid':
    case 'run_not_found':
      return new PlayLaunchError(403, 'run_token_refused', 'Proofy Play did not accept this run token for Rare City.')
    case 'run_already_redeemed':
      return new PlayLaunchError(409, 'run_already_used', 'This launch was already opened.')
    case 'run_expired':
      return new PlayLaunchError(409, 'run_expired', 'This launch has expired.')
    case 'installation_not_active':
      return new PlayLaunchError(403, 'installation_not_active', 'Rare City is not active on this server.')
    default:
      return null
  }
}

const unavailable = () => new PlayLaunchError(503, 'play_unavailable', 'Proofy Play could not be reached or answered outside its contract.')

/** How each refusal of the world store is stated. */
const WORLD_STATUS: Record<WorldRefusalCode, number> = {
  config_invalid: 422,
  config_incompatible: 409,
  config_superseded: 409,
  config_binding_mismatch: 502,
  world_binding_conflict: 409,
  world_unavailable: 503,
}
/**
 * How long the world store waits, holding one world's lock, for Play to confirm the active version
 * before it founds the world or adopts a version. Shorter than the store's lock timeout (5s), so a
 * launch queued behind it still gets the lock; past it, nothing is founded or adopted.
 */
export const ACTIVE_CONFIRM_MS = 3_000

// The database failing is not Play failing: say which. The cause stays in the server log, never in the answer.
const worldUnavailable = (err: unknown) => new PlayLaunchError(503, 'world_unavailable', `The city could not be read or stored: ${err instanceof Error ? err.message : String(err)}`)
const mismatch = (what: string) => new PlayLaunchError(502, 'config_binding_mismatch', `Proofy Play's answer does not belong to this run: ${what}.`)

/**
 * THE LAUNCH PATH: from a run token to a validated brand city, with Play as the only authority.
 *
 *   1. The body is exactly `{ runToken }`. Nothing the browser says names an installation,
 *      a server, a world or a version, so nothing it says can choose one.
 *   2. Play redeems the token with Rare City's credential: Play checks its own signature,
 *      that the audience is Rare City, the expiry, and that the run is used once. Its answer
 *      names the installation, the Discord server and the PINNED configuration version and hash.
 *   3. The installation is read back from Play and must be Rare City's, on the same server, active.
 *   4. The PINNED version is loaded (never "the active one": a run keeps the version it was
 *      launched with, contract §4.4). It must be that installation's, that version, carry the
 *      run's hash, and hash to it when Rare City recomputes Play's canonical JSON.
 *   5. Its schema version must be one this build reads.
 *   6. The installation's PERSISTENT city is opened (`world/store.ts`): founded by its first
 *      launch, the same world on every launch after. Before it founds the world or adopts the
 *      pinned version, the store has Play confirm, once and within ACTIVE_CONFIRM_MS, that the
 *      version is still the installation's active one. The world judges the pinned document:
 *      Rare City's validator, the world engine's, and the rules for how a founded city's
 *      configuration may change. A version it cannot accept is recorded as rejected and refused.
 *
 * Any failure refuses the launch. Nothing is substituted: there is no sample city, no
 * "last good" configuration, no default, and never a second city.
 */
export function createPlayLaunchService({ play, environment, gameKey, worlds, activeConfirmMs = ACTIVE_CONFIRM_MS, clock = () => performance.now() }: PlayLaunchOptions): PlayLaunchService {
  /** The store's one question to Play under its lock: still this installation's, still active, and which version? */
  function confirmActive(installationId: string, discordGuildId: string): ConfirmActive {
    let asked = false
    return async () => {
      if (asked) return null
      asked = true
      // Past the deadline the request is abandoned, not left to run on behind a launch that has moved on.
      const cancel = new AbortController()
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<null>((resolve) => (timer = setTimeout(() => (cancel.abort(), resolve(null)), activeConfirmMs)))
      const answer = play.getInstallation(installationId, { signal: cancel.signal }).then(
        (i) => (i.id === installationId && i.gameKey === gameKey && i.discordGuildId === discordGuildId && i.status === 'active' ? { version: i.activeConfigVersion, configHash: i.activeConfigHash } : null),
        () => null,
      )
      try {
        return await Promise.race([answer, deadline])
      } finally {
        clearTimeout(timer)
      }
    }
  }

  async function ask<T>(work: Promise<T>, refusal: (err: PlayApiError) => PlayLaunchError | null = () => null): Promise<T> {
    try {
      return await work
    } catch (err) {
      if (err instanceof PlayApiError) throw refusal(err) ?? unavailable()
      throw err
    }
  }

  return {
    async open(body) {
      const keys = Object.keys(body)
      if (keys.length !== 1 || keys[0] !== 'runToken' || typeof body.runToken !== 'string' || !RUN_TOKEN_PATTERN.test(body.runToken)) {
        throw new PlayLaunchError(422, 'invalid_request', 'The request must be exactly { runToken }.')
      }

      const run = await ask(play.redeemRun(body.runToken), redeemRefusal)
      if (run.gameKey !== gameKey) throw mismatch('the run is for another game')

      // A run's installation is its own; it is still read back, so a run and an installation that disagree are caught.
      // Timed before the question, so the freshness it starts is never longer than Play's answer supports.
      const installationVerifiedAt = clock()
      const installation = await ask(play.getInstallation(run.installationId), (err) =>
        err.code === 'installation_not_found' ? mismatch('the run names an installation Play does not show to Rare City') : null,
      )
      if (installation.id !== run.installationId || installation.gameKey !== gameKey) throw mismatch('the installation is not this run\'s')
      if (installation.discordGuildId !== run.discordGuildId) throw mismatch('the installation is on another Discord server')
      if (installation.status !== 'active') throw new PlayLaunchError(403, 'installation_not_active', 'Rare City is not active on this server.')

      const version = await ask(play.getConfigVersion(run.installationId, run.configVersion), (err) =>
        err.code === 'config_version_not_found' || err.code === 'installation_not_found' ? mismatch('the pinned configuration version is missing') : null,
      )
      if (version.installationId !== run.installationId) throw mismatch('the configuration belongs to another installation')
      if (version.version !== run.configVersion) throw mismatch('the configuration is not the pinned version')
      if (version.configHash !== run.configHash) throw mismatch('the configuration hash is not the pinned hash')
      let recomputed: string
      try {
        recomputed = canonicalHash(version.config)
      } catch {
        throw mismatch('the configuration is not canonical JSON')
      }
      if (recomputed !== run.configHash) throw mismatch('the configuration does not hash to the pinned hash')

      if (!SUPPORTED_PLAY_SCHEMA_VERSIONS.includes(version.schemaVersion)) {
        throw new PlayLaunchError(422, 'config_schema_unsupported', `Configuration schema version ${version.schemaVersion} is not one this build reads.`)
      }
      let opened
      try {
        opened = await worlds.open(
          {
            environment,
            gameKey,
            installationId: run.installationId,
            discordGuildId: run.discordGuildId,
            active: { version: installation.activeConfigVersion, configHash: installation.activeConfigHash },
            pinned: { version: version.version, schemaVersion: version.schemaVersion, configHash: version.configHash, config: version.config },
          },
          confirmActive(run.installationId, run.discordGuildId),
        )
      } catch (err) {
        if (err instanceof WorldRefusal) throw new PlayLaunchError(WORLD_STATUS[err.code], err.code, err.message, err.problems)
        throw worldUnavailable(err)
      }

      return {
        play: {
          environment,
          gameKey,
          installationId: run.installationId,
          discordGuildId: run.discordGuildId,
          runId: run.runId,
          runExpiresAt: run.runExpiresAt,
          configVersion: version.version,
          configHash: version.configHash,
          schemaVersion: version.schemaVersion,
        },
        player: run.player,
        installationVerifiedAt,
        world: opened.world,
        config: version.config,
      }
    },
  }
}
