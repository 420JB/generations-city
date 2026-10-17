import { parseWorldCityState, type WorldCityState } from '../world/cityState'

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
 * once; reloading means launching again from Proofy Play. The run token is never a session:
 * everything the page needs comes back in this one answer, and there is no other read.
 *
 * The city is PERSISTENT: one world per installation, founded by the installation's first
 * launch and returned by every launch after it, whatever configuration version it runs.
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
  /** The installation's persistent city, as stored. */
  world: PlayWorld
  /**
   * The configuration document of the pinned version, exactly as Play served it (hash-checked)
   * and as the world accepted it: its presentation is drawn, on the world's fixed geometry.
   */
  config: unknown
}

/** The persistent city of an installation (a `worlds` row and its city, migration 0005). */
export interface PlayWorld {
  /** `worlds.id`: the city's permanent identity, a UUIDv7 bound once to this installation. */
  id: string
  provisioned: true
  /** true when this launch founded the city; every later launch returns it unchanged. */
  created: boolean
  foundedAt: string
  /** Authoritative changes the city has had; 1 = as founded. */
  sequence: number
  /** What the city was founded on and which accepted configuration version governs it now. */
  definition: { foundingConfigVersion: number; governingConfigVersion: number; layoutKey: string; geometryFingerprint: string }
  /** The stored state. Version 1 is an empty city: nothing has been claimed or built. */
  state: WorldCityState
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
  /** The pinned configuration would move the city's districts or drop a collection; the city is unchanged. */
  | 'config_incompatible'
  /** The city does not exist yet and this run is pinned to a configuration that is no longer active. */
  | 'config_superseded'
  /** This Discord server's city is bound to another installation (or Play disagrees with the binding). */
  | 'world_binding_conflict'
  /** The city's storage could not be reached, or holds a state this build cannot read. */
  | 'world_unavailable'
  /** Proofy Play could not be reached, or answered outside its contract. */
  | 'play_unavailable'

export interface PlayErrorBody {
  error: PlayErrorCode
  problems?: { path: string; detail: string }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A UUIDv7 (`worlds.id`): never the old derived preview ids, which were UUIDv8. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
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
  if (typeof player.displayName !== 'string') return null
  const parsedWorld = parsePlayWorld(world)
  if (!parsedWorld) return null
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
    world: parsedWorld,
    config: body.config,
  }
}

function parsePlayWorld(world: Record<string, unknown>): PlayWorld | null {
  const { definition: d } = world
  if (typeof world.id !== 'string' || !UUID_V7.test(world.id) || world.provisioned !== true || typeof world.created !== 'boolean') return null
  if (typeof world.foundedAt !== 'string' || Number.isNaN(Date.parse(world.foundedAt)) || !posInt(world.sequence)) return null
  if (!isRecord(d) || !posInt(d.foundingConfigVersion) || !posInt(d.governingConfigVersion) || typeof d.layoutKey !== 'string' || !KEY.test(d.layoutKey) || typeof d.geometryFingerprint !== 'string' || !HASH.test(d.geometryFingerprint)) return null
  const state = parseWorldCityState(world.state)
  if (!state) return null
  return {
    id: world.id,
    provisioned: true,
    created: world.created,
    foundedAt: world.foundedAt,
    sequence: world.sequence,
    definition: { foundingConfigVersion: d.foundingConfigVersion, governingConfigVersion: d.governingConfigVersion, layoutKey: d.layoutKey, geometryFingerprint: d.geometryFingerprint },
    state,
  }
}

/** The run token in a launch URL fragment (`#runToken=…`), or null. */
export function runTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const all = params.getAll(RUN_TOKEN_FRAGMENT_PARAM)
  return all.length === 1 && RUN_TOKEN_PATTERN.test(all[0]) ? all[0] : null
}
