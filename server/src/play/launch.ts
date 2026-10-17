import {
  compileBrandWorld,
  parsePlayCityConfig,
  playPreviewWorldId,
  RUN_TOKEN_PATTERN,
  SUPPORTED_PLAY_SCHEMA_VERSIONS,
  type PlayEnvironment,
  type PlayErrorCode,
  type PlaySessionResponse,
} from '../engine'
import { canonicalHash } from './canonical'
import { PlayApiError, type PlayGameReader } from './client'

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

export interface PlayLaunchService {
  /** Open the city a Play run token was issued for. The body is untrusted. */
  open(body: Record<string, unknown>): Promise<PlaySessionResponse>
}

export interface PlayLaunchOptions {
  play: PlayGameReader
  /** The Play environment of Rare City's credential: what every answer is attributed to. */
  environment: PlayEnvironment
  /** Rare City's game key in Play. */
  gameKey: string
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
 *   5. Its schema version must be one this build reads, and the document must be a valid
 *      Rare City city: Rare City's own validator, then the world engine's.
 *
 * Any failure refuses the launch. Nothing is substituted: there is no sample city, no
 * "last good" configuration, no default.
 */
export function createPlayLaunchService({ play, environment, gameKey }: PlayLaunchOptions): PlayLaunchService {
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
      const worldId = playPreviewWorldId(environment, run.installationId)
      const parsed = parsePlayCityConfig(version.config, worldId)
      if (!parsed.ok) throw new PlayLaunchError(422, 'config_invalid', 'The pinned configuration is not a valid Rare City city.', parsed.problems)
      const compiled = compileBrandWorld(parsed.config)
      if (!compiled.ok) throw new PlayLaunchError(422, 'config_invalid', 'The pinned configuration does not make a valid world.', compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })))

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
        player: { displayName: run.player.displayName },
        world: { id: worldId, provisioned: false },
        config: version.config,
      }
    },
  }
}
