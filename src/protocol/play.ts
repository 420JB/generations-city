/**
 * Wire contract for opening a brand city from a Proofy Play launch. Used by the server and
 * the client. Portable: no browser or Node dependency.
 *
 * Proofy Play launches a player into Rare City by sending the browser to Rare City's
 * registered launch URL with a Play-signed run token in the URL FRAGMENT
 * (`<launchUrl>#runToken=<jwt>`; Play contract 1.1.0 §11: never a query string). The page
 * posts that token here, once:
 *
 *   `POST /v1/play/session`  `{ "runToken": "<jwt>" }`
 *
 * The browser sends nothing else. It never names an installation, a server, a world or a
 * configuration version: the server learns all of them from Play by redeeming the token with
 * Rare City's service credential, then loads the configuration version the run was pinned
 * to and checks it against the run before anything is drawn.
 *
 * Redemption is single use (Play `run_already_redeemed`), so a launch link opens the city
 * once; reloading means launching again from Proofy Play.
 */
export const PLAY_SESSION_ENDPOINT = '/v1/play/session'

/** URL fragment parameter that carries the run token. */
export const RUN_TOKEN_FRAGMENT_PARAM = 'runToken'

/** `POST /v1/play/session` request. Exactly this key. */
export interface PlaySessionRequest {
  runToken: string
}

/** A JWS compact token, bounded. Play's run tokens are a few hundred characters. */
export const RUN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}$/

export interface PlaySessionResponse {
  /** Where the city's configuration came from, as Play reported it and Rare City checked it. */
  play: {
    environment: 'dev' | 'test' | 'staging' | 'live'
    gameKey: string
    installationId: string
    discordGuildId: string
    runId: string
    runExpiresAt: string
    configVersion: number
    configHash: string
    schemaVersion: number
  }
  /** The player Play launched. Presentation only. */
  player: { displayName: string }
  /**
   * The world the city is drawn as. `provisioned: false`: no world is founded for this
   * installation yet, and `id` is the derived preview id (see `playPreviewWorldId`).
   */
  world: { id: string; provisioned: false }
  /** The configuration document of the pinned version, exactly as Play served it (hash-checked). */
  config: unknown
}

/** Error bodies are `{ "error": <code> }`, plus `problems` for `config_invalid`. */
export type PlayErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'origin_mismatch'
  | 'rate_limited'
  /** This deployment is not connected to Proofy Play. */
  | 'play_disabled'
  /** Play did not accept the run token for Rare City: forged, expired, or another game's. */
  | 'run_token_refused'
  /** The run was already opened. */
  | 'run_already_used'
  | 'run_expired'
  | 'installation_not_active'
  /** What Play served does not belong to the run (installation, server, version or hash). */
  | 'config_binding_mismatch'
  /** The run is pinned to a configuration schema version this build cannot read. */
  | 'config_schema_unsupported'
  /** The pinned configuration is not a valid Rare City city. */
  | 'config_invalid'
  /** Proofy Play could not be reached, or answered outside its contract. */
  | 'play_unavailable'

export interface PlayErrorBody {
  error: PlayErrorCode
  problems?: { path: string; detail: string }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const GUILD = /^[0-9]{15,25}$/
const ENVIRONMENTS = ['dev', 'test', 'staging', 'live'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

/** The response body, or null if it is not one. The configuration itself is validated separately. */
export function parsePlaySessionResponse(body: unknown): PlaySessionResponse | null {
  if (!isRecord(body) || !isRecord(body.play) || !isRecord(body.player) || !isRecord(body.world) || !isRecord(body.config)) return null
  const { play, player, world } = body
  if (!(ENVIRONMENTS as readonly unknown[]).includes(play.environment)) return null
  if (typeof play.gameKey !== 'string' || typeof play.installationId !== 'string' || !UUID.test(play.installationId)) return null
  if (typeof play.discordGuildId !== 'string' || !GUILD.test(play.discordGuildId)) return null
  if (typeof play.runId !== 'string' || !UUID.test(play.runId) || typeof play.runExpiresAt !== 'string') return null
  if (!posInt(play.configVersion) || !posInt(play.schemaVersion) || typeof play.configHash !== 'string' || !HASH.test(play.configHash)) return null
  if (typeof player.displayName !== 'string' || typeof world.id !== 'string' || !UUID.test(world.id) || world.provisioned !== false) return null
  return {
    play: {
      environment: play.environment as PlaySessionResponse['play']['environment'],
      gameKey: play.gameKey,
      installationId: play.installationId,
      discordGuildId: play.discordGuildId,
      runId: play.runId,
      runExpiresAt: play.runExpiresAt,
      configVersion: play.configVersion,
      configHash: play.configHash,
      schemaVersion: play.schemaVersion,
    },
    player: { displayName: player.displayName },
    world: { id: world.id, provisioned: false },
    config: body.config,
  }
}

/** The run token in a launch URL fragment (`#runToken=…`), or null. */
export function runTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const all = params.getAll(RUN_TOKEN_FRAGMENT_PARAM)
  return all.length === 1 && RUN_TOKEN_PATTERN.test(all[0]) ? all[0] : null
}
